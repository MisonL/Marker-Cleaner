import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import pLimit from "p-limit";
import { cleanMarkersLocal, convertFormat, getOutputExtension } from "./cleaner";
import type { Config, Progress } from "./config-manager";
import { loadProgress, saveProgress } from "./config-manager";
import { type ReportItem, type TaskNavigation, generateHtmlReport } from "./report-generator";
import type { AIProvider, BatchTask, Logger, ProcessResult } from "./types";
import { formatDuration } from "./utils";

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];

export type ConflictDecision = "skip" | "overwrite" | "rename";

export interface BatchProcessorOptions {
  config: Config;
  provider: AIProvider;
  logger: Logger;
  onProgress?: (
    current: number,
    total: number,
    file: string,
    stats?: {
      lastTaskTokens?: { input: number; output: number };
      lastTaskDuration?: number;
      lastTaskThumbnail?: Buffer;
      accumulatedCost?: number;
    },
  ) => void;
  onCostUpdate?: (cost: number) => void;
  onConflict?: (file: string) => Promise<ConflictDecision>;
}

export class BatchProcessor {
  private config: Config;
  private provider: AIProvider;
  private logger: Logger;
  private progress: Progress;
  private onProgress?: BatchProcessorOptions["onProgress"];
  private onCostUpdate?: (cost: number) => void;
  private onConflict?: BatchProcessorOptions["onConflict"];
  private reportData: ReportItem[] = [];
  private isCancelled = false;

  constructor(options: BatchProcessorOptions) {
    this.config = options.config;
    this.provider = options.provider;
    this.logger = options.logger;
    this.onProgress = options.onProgress;
    this.onCostUpdate = options.onCostUpdate;
    this.onConflict = options.onConflict;
    this.progress = loadProgress();
  }

  /**
   * 扫描输入目录，获取所有待处理的图片任务
   */
  scanTasks(): BatchTask[] {
    const tasks: BatchTask[] = [];
    const inputDir = this.config.inputDir;

    if (!existsSync(inputDir)) {
      throw new Error(`输入目录不存在: ${inputDir}`);
    }

    this.scanDir(inputDir, inputDir, tasks);
    return tasks;
  }

  private scanDir(baseDir: string, currentDir: string, tasks: BatchTask[]): void {
    const entries = readdirSync(currentDir);

    for (const entry of entries) {
      const fullPath = join(currentDir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        if (this.config.recursive) {
          this.scanDir(baseDir, fullPath, tasks);
        }
      } else if (stat.isFile()) {
        const ext = extname(entry).toLowerCase();
        if (IMAGE_EXTENSIONS.includes(ext)) {
          const relativePath = relative(baseDir, fullPath);
          const outputPath = this.getOutputPath(relativePath);

          tasks.push({
            relativePath,
            absoluteInputPath: fullPath,
            absoluteOutputPath: outputPath,
          });
        }
      }
    }
  }

  private getOutputPath(relativePath: string): string {
    const ext = extname(relativePath);
    const baseName = basename(relativePath, ext);
    const dirName = dirname(relativePath);

    const newExt = getOutputExtension(this.config.outputFormat, ext);

    const rules = this.config.renameRules;
    let suffix = "";

    if (rules.enabled) {
      if (rules.timestamp) {
        // 生成时间戳 YYYYMMDD_HHmmss
        const now = new Date();
        const timestamp = now
          .toISOString()
          .replace(/[-:T]/g, "")
          .slice(0, 14) // YYYYMMDDHHMMSS
          .replace(/(\d{8})(\d{6})/, "$1_$2"); // YYYYMMDD_HHMMSS
        suffix += `_${timestamp}`;
      }
      if (rules.suffix) {
        suffix = rules.suffix + suffix;
      }
    }

    if (this.config.preserveStructure) {
      return join(this.config.outputDir, dirName, baseName + suffix + newExt);
    }
    return join(this.config.outputDir, baseName + suffix + newExt);
  }

  /**
   * 过滤已处理的任务
   */
  filterPendingTasks(tasks: BatchTask[]): BatchTask[] {
    const processed = new Set(this.progress.processedFiles);
    return tasks.filter((task) => !processed.has(task.relativePath));
  }

  /**
   * 执行批处理
   */
  async process(
    tasks: BatchTask[],
    previewOnly = false,
    skipReport = false,
  ): Promise<{
    reportPath?: string;
    totalSuccess: number;
    totalFailed: number;
    totalCost: number;
    totalTokens: { input: number; output: number };
  }> {
    this.isCancelled = false; // 重置取消状态
    const pendingTasks = previewOnly ? tasks.slice(0, this.config.previewCount) : tasks;

    let current = 0;
    const total = pendingTasks.length;
    let sessionCostDelta = 0; // 修改：只追踪本次会话的增量
    let sessionInputTokens = 0;
    let sessionOutputTokens = 0;
    let successCount = 0;
    let failedCount = 0;

    this.reportData = [];
    this.onCostUpdate?.(this.progress.totalCost); // 初始化显示当前全局成本

    // 创建当前任务文件夹
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, "")
      .slice(0, 14) // YYYYMMDDHHMMSS
      .replace(/(\d{8})(\d{6})/, "$1_$2");
    const taskDirName = `task_${timestamp}`;
    const taskDir = join(this.config.outputDir, taskDirName);

    if (!previewOnly && !skipReport && !existsSync(taskDir)) {
      mkdirSync(taskDir, { recursive: true });
    }

    const limit = pLimit(this.config.concurrency);

    const taskPromises = pendingTasks.map((task) =>
      limit(async () => {
        if (this.isCancelled) return; // 取消时直接跳过

        // 成本熔断检查 (budgetLimit > 0 表示启用)
        const currentGlobalCost = this.progress.totalCost + sessionCostDelta;
        if (this.config.budgetLimit > 0 && currentGlobalCost >= this.config.budgetLimit) {
          this.logger.warn(
            `🛑 已达到成本预算上限 ($${this.config.budgetLimit})，跳过任务: ${task.relativePath}`,
          );
          return;
        }

        current++;
        const taskStartTime = Date.now();
        this.logger.info(`[${current}/${total}] 正在处理: ${task.relativePath}`);

        // 任务开始前先发出一次进度通知
        this.onProgress?.(current, total, task.relativePath);

        // 计算目标路径：
        // 如果是预览或跳过报告，直接使用预计算的路径 (通常在 outputDir 下)
        // 否则，我们需要将预计算的文件名（含后缀和新扩展名）放到 taskDir 下
        let finalOutputPath = task.absoluteOutputPath;
        if (!previewOnly && !skipReport) {
          const relativeToOutput = relative(this.config.outputDir, task.absoluteOutputPath);
          finalOutputPath = join(taskDir, relativeToOutput);
        }

        // 冲突检测 (基础重名检测)
        if (existsSync(finalOutputPath)) {
          if (this.onConflict) {
            const decision = await this.onConflict(task.relativePath);
            if (decision === "skip") {
              this.logger.info(`⏭️  跳过回访: ${task.relativePath}`);
              return;
            }

            if (decision === "rename") {
              finalOutputPath = this.generateUniquePath(finalOutputPath);
            }
          } else {
            // 默认策略：自动重命名以避免覆盖
            finalOutputPath = this.generateUniquePath(finalOutputPath);
          }
        }

        try {
          const inputBuffer = readFileSync(task.absoluteInputPath);
          const result = await this.processOne(inputBuffer, task.relativePath);
          const taskEndTime = Date.now();
          const duration = taskEndTime - taskStartTime;

          // 实时成本计算与 UI 反馈
          const pricing = this.config.pricing;
          const taskCost =
            ((result.inputTokens || 0) / 1_000_000) * pricing.inputTokenPer1M +
            ((result.outputTokens || 0) / 1_000_000) * pricing.outputTokenPer1M +
            (result.isImageEdit ? pricing.imageOutput : 0);

          // 线程安全增量更新
          sessionCostDelta += taskCost;
          sessionInputTokens += result.inputTokens || 0;
          sessionOutputTokens += result.outputTokens || 0;
          successCount++;

          this.onProgress?.(current, total, task.relativePath, {
            lastTaskTokens: { input: result.inputTokens, output: result.outputTokens },
            lastTaskDuration: duration,
            lastTaskThumbnail: result.outputBuffer,
            accumulatedCost: sessionCostDelta,
          });

          // 收集报告数据 (需保证顺序或最终排序，此处暂且推入)
          this.reportData.push({
            file: task.relativePath,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            cost: taskCost,
            duration: duration,
            success: true,
            outputBuffer: result.outputBuffer,
            inputBuffer: readFileSync(task.absoluteInputPath),
          });

          if (!previewOnly) {
            this.progress.totalInputTokens += result.inputTokens || 0;
            this.progress.totalOutputTokens += result.outputTokens || 0;
            if (result.isImageEdit) this.progress.totalImageOutputs++;
            this.progress.totalCost += taskCost;
            this.progress.processedFiles.push(task.relativePath);
            saveProgress(this.progress);
          }

          this.onCostUpdate?.(this.progress.totalCost);

          if (result.outputBuffer) {
            const dir = dirname(finalOutputPath);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            writeFileSync(finalOutputPath, result.outputBuffer);
          }
        } catch (error) {
          this.logger.error(`处理失败: ${task.relativePath} - ${error}`);
          failedCount++;
          this.reportData.push({
            file: task.relativePath,
            success: false,
            error: String(error),
          });
        }
      }),
    );

    await Promise.all(taskPromises);

    this.logger.info(`✅ 处理完成: ${current}/${total}`);
    this.logger.info(`💰 会话消耗成本: $${sessionCostDelta.toFixed(4)}`);

    let reportPath: string | undefined;
    if (this.reportData.length > 0 && !previewOnly && !skipReport) {
      reportPath = this.generateReport(taskDir);
    }

    return {
      reportPath,
      totalSuccess: successCount,
      totalFailed: failedCount,
      totalCost: sessionCostDelta, // 修改：返回本次会话增量
      totalTokens: { input: sessionInputTokens, output: sessionOutputTokens },
    };
  }

  private generateReport(targetDir: string): string {
    const reportName = "task_report.html";
    const reportPath = join(targetDir, reportName);
    this.logger.info(`📊 正在生成处理报告: ${reportPath}`);

    try {
      // 扫描所有任务文件夹，构建导航
      const allTaskNav: TaskNavigation[] = [];
      try {
        if (existsSync(this.config.outputDir)) {
          const dirs = readdirSync(this.config.outputDir).filter((d) => {
            const fullPath = join(this.config.outputDir, d);
            return (
              d.startsWith("task_") &&
              statSync(fullPath).isDirectory() &&
              existsSync(join(fullPath, reportName))
            );
          });

          // 按名称（时间戳）倒序排列
          dirs.sort().reverse();

          for (const d of dirs) {
            const isCurrent = join(this.config.outputDir, d) === targetDir;
            // 相对路径：从当前报告目录到其他任务报告
            // 当前在 output/task_current/task_report.html
            // 目标在 output/task_other/task_report.html -> ../task_other/task_report.html
            const relativeReportPath = isCurrent ? reportName : `../${d}/${reportName}`;

            allTaskNav.push({
              id: d,
              name: d.replace("task_", ""),
              relativeReportPath,
              isCurrent,
            });
          }
        }
      } catch (e) {
        this.logger.warn(`扫描任务历史失败: ${e}`);
      }

      const { generateHtmlReport } = require("./report-generator");
      generateHtmlReport(reportPath, this.reportData, allTaskNav);
      return reportPath;
    } catch (error) {
      this.logger.error(`生成报告失败: ${error}`);
      return "";
    }
  }

  private async processOne(
    inputBuffer: Buffer,
    relativePath: string,
  ): Promise<{
    success: boolean;
    inputTokens: number;
    outputTokens: number;
    isImageEdit: boolean;
    outputBuffer: Buffer;
  }> {
    // 选择 Prompt
    const prompt = this.provider.supportsImageEdit
      ? this.config.prompts.edit
      : this.config.prompts.detect;

    // 调用 AI (使用配置的超时时间)
    const MAX_TIMEOUT = this.config.taskTimeout;
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`AI 处理超时 (${MAX_TIMEOUT / 1000}s)`)), MAX_TIMEOUT),
    );

    const result = (await Promise.race([
      this.provider.processImage(inputBuffer, prompt),
      timeoutPromise,
    ])) as ProcessResult;
    const isImageEdit = !!result.outputBuffer;

    if (!result.success) {
      throw new Error(result.error ?? "Unknown error");
    }

    let outputBuffer: Buffer;

    if (result.outputBuffer) {
      // Pro 模式：AI 直接返回图片
      outputBuffer = result.outputBuffer;
    } else if (result.boxes && result.boxes.length > 0) {
      // Detection 模式：本地修复
      this.logger.debug(`检测到 ${result.boxes.length} 个标记区域，执行本地修复`);
      outputBuffer = await cleanMarkersLocal(inputBuffer, result.boxes);
    } else {
      // 没有检测到标记，直接复制原图
      this.logger.debug("未检测到标记，保持原图");
      outputBuffer = inputBuffer;
    }

    // 转换格式
    outputBuffer = await convertFormat(
      outputBuffer,
      this.config.outputFormat,
      extname(relativePath),
    );

    return {
      success: true,
      inputTokens: result.inputTokens || 0,
      outputTokens: result.outputTokens || 0,
      isImageEdit,
      outputBuffer,
    };
  }

  private updateCost(): void {
    const pricing = this.config.pricing;
    const inputCost = (this.progress.totalInputTokens / 1_000_000) * pricing.inputTokenPer1M;
    const outputCost = (this.progress.totalOutputTokens / 1_000_000) * pricing.outputTokenPer1M;
    const imageCost = this.progress.totalImageOutputs * pricing.imageOutput;
    this.progress.totalCost = inputCost + outputCost + imageCost;
    this.onCostUpdate?.(this.progress.totalCost);
  }

  /**
   * 获取当前进度
   */
  getProgress(): Progress {
    return this.progress;
  }

  /**
   * 清除进度
   */
  clearProgress(): void {
    this.progress = {
      processedFiles: [],
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalImageOutputs: 0,
      totalCost: 0,
      lastUpdated: new Date().toISOString(),
    };
    saveProgress(this.progress);
  }

  /**
   * 生成唯一路径 (增加序号)
   */
  private generateUniquePath(originalPath: string): string {
    const ext = extname(originalPath);
    const base = originalPath.slice(0, originalPath.length - ext.length);
    let counter = 1;
    let newPath = originalPath;

    while (existsSync(newPath)) {
      newPath = `${base}_${counter}${ext}`;
      counter++;
    }
    return newPath;
  }

  /**
   * 停止当前所有任务
   */
  stop(): void {
    this.isCancelled = true;
    this.logger.warn("🛑 用户请求停止任务，正在取消其余队列...");
  }
}

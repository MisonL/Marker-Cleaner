import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { cleanMarkersLocal, convertFormat, getOutputExtension } from "./cleaner";
import type { Config, Progress } from "./config-manager";
import { loadProgress, saveProgress } from "./config-manager";
import { type ReportItem, generateHtmlReport } from "./report-generator";
import type { AIProvider, BatchTask, Logger } from "./types";
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
  async process(tasks: BatchTask[], previewOnly = false): Promise<void> {
    const pendingTasks = previewOnly ? tasks.slice(0, this.config.previewCount) : tasks;

    let current = 0;
    const total = pendingTasks.length;
    let sessionCost = this.progress.totalCost;
    this.reportData = [];

    for (const task of pendingTasks) {
      // 成本熔断检查
      if (this.config.budgetLimit > 0 && sessionCost >= this.config.budgetLimit) {
        this.logger.warn(`🛑 已达到成本预算上限 ($${this.config.budgetLimit})，熔断机制触发。`);
        break;
      }

      current++;
      const taskStartTime = Date.now();
      this.logger.info(`[${current}/${total}] 处理: ${task.relativePath}`);

      let finalOutputPath = task.absoluteOutputPath;

      // 冲突检测 (基础重名检测，不带时间戳也可以触发)
      if (existsSync(finalOutputPath)) {
        if (this.onConflict) {
          const decision = await this.onConflict(task.relativePath);
          if (decision === "skip") {
            this.logger.info(`⏭️  用户选择跳过: ${task.relativePath}`);
            continue;
          }

          if (decision === "rename") {
            finalOutputPath = this.generateUniquePath(finalOutputPath);
            this.logger.info(`📝 自动重命名为: ${basename(finalOutputPath)}`);
          } else {
            this.logger.info(`⚠️  用户选择覆盖: ${task.relativePath}`);
          }
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

        sessionCost += taskCost;
        this.onCostUpdate?.(sessionCost);

        this.onProgress?.(current, total, task.relativePath, {
          lastTaskTokens: { input: result.inputTokens, output: result.outputTokens },
          lastTaskDuration: duration,
          lastTaskThumbnail: result.outputBuffer,
          accumulatedCost: sessionCost,
        });

        // 收集报告数据
        this.reportData.push({
          file: task.relativePath,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cost: taskCost,
          duration: duration,
          success: true,
          outputBuffer: result.outputBuffer,
          inputBuffer: readFileSync(task.absoluteInputPath), // 用于后期生成对比报表
        });

        if (!previewOnly) {
          if (result.inputTokens) this.progress.totalInputTokens += result.inputTokens;
          if (result.outputTokens) this.progress.totalOutputTokens += result.outputTokens;
          if (result.isImageEdit) this.progress.totalImageOutputs++;

          this.progress.totalCost = sessionCost; // 正式模式同步持久化成本
          this.progress.processedFiles.push(task.relativePath);
          saveProgress(this.progress);
        }

        // 确保输出目录存在并保存文件
        if (result.outputBuffer) {
          const dir = dirname(finalOutputPath);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          writeFileSync(finalOutputPath, result.outputBuffer);
          this.logger.debug(`已保存: ${finalOutputPath}`);
        }
      } catch (error) {
        this.logger.error(`处理失败: ${task.relativePath} - ${error}`);
        this.reportData.push({
          file: task.relativePath,
          success: false,
          error: String(error),
        });
      }
    }

    this.logger.info(`✅ 处理完成: ${current}/${total}`);
    this.logger.info(`💰 会话累计成本: $${sessionCost.toFixed(4)}`);

    if (this.reportData.length > 0 && !previewOnly) {
      this.generateReport();
    }
  }

  private generateReport() {
    const reportName = `report_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.html`;

    // 写入报告前确保输出目录存在
    if (!existsSync(this.config.outputDir)) {
      mkdirSync(this.config.outputDir, { recursive: true });
    }

    const reportPath = join(this.config.outputDir, reportName);
    this.logger.info(`📊 正在生成处理报告: ${reportName}`);

    try {
      generateHtmlReport(reportPath, this.reportData);
    } catch (error) {
      this.logger.error(`生成报告失败: ${error}`);
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

    // 调用 AI
    const result = await this.provider.processImage(inputBuffer, prompt);
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
}

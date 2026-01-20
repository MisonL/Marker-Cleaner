import { readdirSync, statSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, relative, dirname, extname, basename } from "path";
import type { Config, Progress } from "./config-manager";
import { loadProgress, saveProgress } from "./config-manager";
import type { AIProvider, BatchTask, Logger } from "./types";
import { cleanMarkersLocal, convertFormat, getOutputExtension } from "./cleaner";

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];

export interface BatchProcessorOptions {
  config: Config;
  provider: AIProvider;
  logger: Logger;
  onProgress?: (current: number, total: number, file: string) => void;
  onCostUpdate?: (cost: number) => void;
}

export class BatchProcessor {
  private config: Config;
  private provider: AIProvider;
  private logger: Logger;
  private progress: Progress;
  private onProgress?: (current: number, total: number, file: string) => void;
  private onCostUpdate?: (cost: number) => void;

  constructor(options: BatchProcessorOptions) {
    this.config = options.config;
    this.provider = options.provider;
    this.logger = options.logger;
    this.onProgress = options.onProgress;
    this.onCostUpdate = options.onCostUpdate;
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

    if (this.config.preserveStructure) {
      return join(this.config.outputDir, dirName, baseName + newExt);
    } else {
      return join(this.config.outputDir, baseName + newExt);
    }
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
    const pendingTasks = previewOnly
      ? tasks.slice(0, this.config.previewCount)
      : tasks;

    let current = 0;
    const total = pendingTasks.length;

    for (const task of pendingTasks) {
      current++;
      this.onProgress?.(current, total, task.relativePath);
      this.logger.info(`[${current}/${total}] 处理: ${task.relativePath}`);

      try {
        await this.processOne(task);
        if (!previewOnly) {
          this.progress.processedFiles.push(task.relativePath);
          saveProgress(this.progress);
        }
      } catch (error) {
        this.logger.error(`处理失败: ${task.relativePath} - ${error}`);
      }
    }

    this.logger.info(`✅ 处理完成: ${current}/${total}`);
    this.logger.info(`💰 总成本: $${this.progress.totalCost.toFixed(4)}`);
  }

  private async processOne(task: BatchTask): Promise<void> {
    const inputBuffer = readFileSync(task.absoluteInputPath);

    // 选择 Prompt
    const prompt = this.provider.supportsImageEdit
      ? this.config.prompts.edit
      : this.config.prompts.detect;

    // 调用 AI
    const result = await this.provider.processImage(inputBuffer, prompt);

    // 更新 Token 统计
    if (result.inputTokens) {
      this.progress.totalInputTokens += result.inputTokens;
    }
    if (result.outputTokens) {
      this.progress.totalOutputTokens += result.outputTokens;
    }

    // 计算成本
    this.updateCost();

    if (!result.success) {
      throw new Error(result.error ?? "Unknown error");
    }

    let outputBuffer: Buffer;

    if (result.outputBuffer) {
      // Pro 模式：AI 直接返回图片
      outputBuffer = result.outputBuffer;
      this.progress.totalImageOutputs++; // 追踪图片生成次数
    } else if (result.boxes && result.boxes.length > 0) {
      // Nano 模式：本地修复
      this.logger.debug(`检测到 ${result.boxes.length} 个标记区域，执行本地修复`);
      outputBuffer = await cleanMarkersLocal(inputBuffer, result.boxes);
    } else {
      // 没有检测到标记，直接复制原图
      this.logger.debug(`未检测到标记，保持原图`);
      outputBuffer = inputBuffer;
    }

    // 转换格式
    outputBuffer = await convertFormat(outputBuffer, this.config.outputFormat, extname(task.relativePath));

    // 确保输出目录存在
    const outputDir = dirname(task.absoluteOutputPath);
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    // 保存
    writeFileSync(task.absoluteOutputPath, outputBuffer);
    this.logger.debug(`已保存: ${task.absoluteOutputPath}`);
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
}

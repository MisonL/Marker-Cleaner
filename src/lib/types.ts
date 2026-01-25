// 图像清理统计指标 (用于回归套件)
export interface CleanerStats {
  changedPixels: number; // 总共修改的像素数
  fallbackPixels: number; // 触发 fallback 兜底填充的像素数
  totalPixels: number; // 图片总像素
  durationMs: number; // 纯算法执行耗时
}

export interface CleanerResult {
  outputBuffer: Buffer;
  stats: CleanerStats;
}

// AI Provider 通用接口
export interface BoundingBox {
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
}

export interface ProcessResult {
  success: boolean;
  outputBuffer?: Buffer;
  boxes?: BoundingBox[];
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
}

export interface AIProvider {
  /**
   * 处理图片 - 根据模型能力自动选择编辑或检测模式
   * @param imageBuffer 输入图片 Buffer
   * @param prompt 提示词
   * @returns ProcessResult
   */
  processImage(imageBuffer: Buffer, prompt: string): Promise<ProcessResult>;

  /**
   * Provider 名称
   */
  readonly name: string;

  /**
   * 是否支持原生图片编辑
   */
  readonly supportsImageEdit: boolean;
}

// 日志接口
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

// 批处理任务
export interface BatchTask {
  relativePath: string;
  absoluteInputPath: string;
  absoluteOutputPath: string;
}

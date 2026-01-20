import { z } from "zod";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// ============ Schema 定义 ============
const PricingSchema = z.object({
  inputTokenPer1M: z.number().default(0.15),
  outputTokenPer1M: z.number().default(0.6),
  imageOutput: z.number().default(0.039),
});

const PromptsSchema = z.object({
  edit: z
    .string()
    .default(
      "请移除图中所有手动添加的彩色矩形标记框（通常是红色、橙色或黄色的细线边框），保持背景内容完整不变。直接返回处理后的图片。",
    ),
  detect: z
    .string()
    .default(
      "请识别图中所有人工添加的彩色矩形标记框（通常是红色、橙色或黄色的细线边框），返回它们的边界框坐标。格式：JSON 数组 [{ymin, xmin, ymax, xmax}]，坐标为相对值(0-1)。",
    ),
});

const ProviderSettingsSchema = z.object({
  apiKey: z.string().default(""),
  baseUrl: z.string().optional(),
  modelName: z.string(),
});

export const ConfigSchema = z.object({
  // 目录配置
  inputDir: z.string().default("./input"),
  outputDir: z.string().default("./output"),
  recursive: z.boolean().default(true),
  preserveStructure: z.boolean().default(true),

  // Provider 配置
  provider: z.enum(["google", "openai", "antigravity"]).default("antigravity"),
  apiKey: z.string().default(""),
  baseUrl: z.string().optional(),
  modelName: z.string().default("nano-banana-pro"),

  // 各 Provider 独立的档案袋配置
  providerSettings: z.object({
    google: ProviderSettingsSchema,
    openai: ProviderSettingsSchema,
    antigravity: ProviderSettingsSchema,
  }).default({
    google: { apiKey: "", modelName: "gemini-2.5-flash-image" },
    openai: { apiKey: "", modelName: "gpt-4o" },
    antigravity: { apiKey: "", modelName: "nano-banana-pro" },
  }),

  // Prompt 配置
  prompts: PromptsSchema.default({
    edit: "请移除图中所有手动添加的彩色矩形标记框（通常是红色、橙色或黄色的细线边框），保持背景内容完整不变。直接返回处理后的图片。",
    detect: "请识别图中所有人工添加的彩色矩形标记框（通常是红色、橙色或黄色的细线边框），返回它们的边界框坐标。格式：JSON 数组 [{ymin, xmin, ymax, xmax}]，坐标为相对值(0-1)。",
  }),

  // 输出配置
  outputFormat: z.enum(["original", "png", "jpg", "webp"]).default("original"),

  // 高级配置
  previewCount: z.number().min(0).default(3),
  debugLog: z.boolean().default(false),

  // 定价配置
  pricing: PricingSchema.default({
    inputTokenPer1M: 0.15,
    outputTokenPer1M: 0.60,
    imageOutput: 0.039,
  }),
});

export type Config = z.infer<typeof ConfigSchema>;
export type Pricing = z.infer<typeof PricingSchema>;
export type Prompts = z.infer<typeof PromptsSchema>;

// ============ 配置管理器 ============
const CONFIG_FILE = "marker-cleaner.json";

export function getDefaultConfig(): Config {
  return ConfigSchema.parse({});
}

/**
 * 加载配置，如果不存在则创建默认配置
 */
export function loadConfig(cwd: string = process.cwd()): Config {
  const configPath = join(cwd, CONFIG_FILE);

  if (!existsSync(configPath)) {
    // 配置文件不存在，创建默认配置
    const defaultConfig = getDefaultConfig();
    saveConfig(defaultConfig, cwd);
    console.log(`✅ 已创建默认配置文件: ${configPath}`);
    return defaultConfig;
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    const result = ConfigSchema.safeParse(parsed);
    if (result.success) {
      return result.data;
    }
    
    // 解析失败，尝试合并默认值并再次安全解析
    console.warn(`⚠️ 配置文件验证失败，正在尝试修复部分非法字段...`);
    
    // 向后兼容处理
    if (parsed.provider === "google gemini api (需要tier1+层级)") {
      parsed.provider = "google";
    }
    if (parsed.providerSettings?.["google gemini api (需要tier1+层级)"]) {
      parsed.providerSettings.google = parsed.providerSettings["google gemini api (需要tier1+层级)"];
      delete parsed.providerSettings["google gemini api (需要tier1+层级)"];
    }

    const defaultConfig = getDefaultConfig();
    const merged = { ...defaultConfig, ...parsed };
    // 嵌套项合并
    if (parsed.prompts) merged.prompts = { ...defaultConfig.prompts, ...parsed.prompts };
    if (parsed.pricing) merged.pricing = { ...defaultConfig.pricing, ...parsed.pricing };
    if (parsed.providerSettings) merged.providerSettings = { ...defaultConfig.providerSettings, ...parsed.providerSettings };

    const retryResult = ConfigSchema.safeParse(merged);
    if (retryResult.success) {
      return retryResult.data;
    }
    
    console.error(`⚠️ 配置修复失败: ${retryResult.error.message}. 使用默认配置。`);
    return defaultConfig;
  } catch (error) {
    console.error(`⚠️ 配置文件无法读取或格式错误，使用默认配置`);
    return getDefaultConfig();
  }
}

/**
 * 保存配置到文件
 */
export function saveConfig(config: Config, cwd: string = process.cwd()): void {
  const configPath = join(cwd, CONFIG_FILE);
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * 恢复默认配置
 */
export function resetConfig(cwd: string = process.cwd()): Config {
  const defaultConfig = getDefaultConfig();
  saveConfig(defaultConfig, cwd);
  return defaultConfig;
}

// ============ 进度管理 ============
const PROGRESS_FILE = "progress.json";

export interface Progress {
  processedFiles: string[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalImageOutputs: number;
  totalCost: number;
  lastUpdated: string;
}

/**
 * 加载处理进度
 */
export function loadProgress(cwd: string = process.cwd()): Progress {
  const progressPath = join(cwd, PROGRESS_FILE);

  if (!existsSync(progressPath)) {
    return {
      processedFiles: [],
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalImageOutputs: 0,
      totalCost: 0,
      lastUpdated: new Date().toISOString(),
    };
  }

  try {
    const raw = readFileSync(progressPath, "utf-8");
    return JSON.parse(raw) as Progress;
  } catch {
    return {
      processedFiles: [],
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalImageOutputs: 0,
      totalCost: 0,
      lastUpdated: new Date().toISOString(),
    };
  }
}

/**
 * 保存进度
 */
export function saveProgress(
  progress: Progress,
  cwd: string = process.cwd(),
): void {
  const progressPath = join(cwd, PROGRESS_FILE);
  progress.lastUpdated = new Date().toISOString();
  writeFileSync(progressPath, JSON.stringify(progress, null, 2), "utf-8");
}

/**
 * 清除进度
 */
export function clearProgress(cwd: string = process.cwd()): void {
  const progressPath = join(cwd, PROGRESS_FILE);
  if (existsSync(progressPath)) {
    writeFileSync(
      progressPath,
      JSON.stringify(
        {
          processedFiles: [],
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalImageOutputs: 0,
          totalCost: 0,
          lastUpdated: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf-8",
    );
  }
}

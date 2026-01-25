import {
  type GenerateContentResult,
  type GenerationConfig,
  GoogleGenerativeAI,
  type RequestOptions,
} from "@google/generative-ai";
import type { Config } from "../config-manager";
import type { AIProvider, ProcessResult } from "../types";
import { detectMimeType, isExplicitEmptyBoxesResponse, parseBoxesFromText, sleep } from "../utils";

export class GoogleProvider implements AIProvider {
  readonly name = "Google Gemini";
  readonly supportsImageEdit: boolean;

  private client: GoogleGenerativeAI;
  private modelName: string;
  private requestOptions: RequestOptions;

  constructor(config: Config) {
    this.client = new GoogleGenerativeAI(config.apiKey);
    this.modelName = config.modelName;

    // 支持自定义 Base URL (用于代理)
    this.requestOptions = {};
    if (config.baseUrl) {
      this.requestOptions.baseUrl = config.baseUrl;
    }

    // 判断是否支持原生图片编辑 (带 "image" 的模型名)
    this.supportsImageEdit = this.modelName.toLowerCase().includes("image");
  }

  async processImage(imageBuffer: Buffer, prompt: string): Promise<ProcessResult> {
    try {
      const base64 = imageBuffer.toString("base64");
      const mimeType = detectMimeType(imageBuffer);

      // 如果模型名称包含 "image"，开启多模态生成模式
      const generationConfig: GenerationConfig = {};
      if (this.modelName.toLowerCase().includes("image")) {
        /* biome-ignore lint/suspicious/noExplicitAny: SDK type missing responseModalities */
        (generationConfig as any).responseModalities = ["TEXT", "IMAGE"];
      }

      const model = this.client.getGenerativeModel(
        { model: this.modelName, generationConfig },
        this.requestOptions,
      );

      let lastError: unknown;
      const maxRetries = 3;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          if (attempt > 0) {
            const delay = Math.min(1000 * 2 ** attempt, 10000);
            await sleep(delay);
          }

          const response = await model.generateContent([
            {
              inlineData: {
                mimeType,
                data: base64,
              },
            },
            prompt,
          ]);

          return this.parseResponse(response);
        } catch (error: unknown) {
          lastError = error;
          // biome-ignore lint/suspicious/noExplicitAny: error handling
          const err = error as any;
          const status = err?.status || err?.response?.status;
          const message = err?.message || String(error);

          // 只有 429 (Too Many Requests) 或 5xx 错误才重试
          const isRetryable =
            status === 429 ||
            (status >= 500 && status < 600) ||
            message.includes("fetch failed") ||
            message.includes("socket");

          if (!isRetryable || attempt === maxRetries) {
            break;
          }
        }
      }

      return {
        success: false,
        error: lastError instanceof Error ? lastError.message : String(lastError),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private parseResponse(response: GenerateContentResult): ProcessResult {
    try {
      const candidates = response.response.candidates;
      if (!candidates || candidates.length === 0) {
        return { success: false, error: "AI 未返回任何候选结果 (可能受到安全策略拦截或内容违规)" };
      }

      const usage = response.response.usageMetadata;
      const inputTokens = usage?.promptTokenCount ?? 0;
      const outputTokens = usage?.candidatesTokenCount ?? 0;

      // 获取文本内容进行坐标解析 (Detection 模式)
      let text = "";
      try {
        text = response.response.text();
      } catch (e) {
        // 如果 text() 抛错，说明可能无法提取文本
      }

      // 1. 尝试解析坐标 (Detection 模式优先)
      if (text) {
        const boxes = parseBoxesFromText(text);
        if (boxes.length > 0) {
          return {
            success: true,
            boxes,
            inputTokens,
            outputTokens,
          };
        }

        // 明确空结果：视为无需清理
        if (isExplicitEmptyBoxesResponse(text)) {
          return {
            success: true,
            boxes: [],
            inputTokens,
            outputTokens,
          };
        }
      }

      // 2. 检查是否有图片返回 (Native 模式)
      const part = candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
      if (part?.inlineData?.data) {
        return {
          success: true,
          outputBuffer: Buffer.from(part.inlineData.data, "base64"),
          inputTokens,
          outputTokens,
        };
      }

      // 3. 回退处理
      return {
        success: false,
        error: text
          ? `AI 返回文本但未识别出有效坐标: ${text.slice(0, 100)}...`
          : "AI 响应中未包含有效文本或图片数据",
        inputTokens,
        outputTokens,
      };
    } catch (error) {
      return {
        success: false,
        error: `解析 AI 响应时发生异常: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

import {
  type GenerateContentResult,
  GoogleGenerativeAI,
  type RequestOptions,
} from "@google/generative-ai";
import type { Config } from "../config-manager";
import type { AIProvider, ProcessResult } from "../types";
import { detectMimeType, parseBoxesFromText } from "../utils";

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

      const model = this.client.getGenerativeModel({ model: this.modelName }, this.requestOptions);
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
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private parseResponse(response: GenerateContentResult): ProcessResult {
    const candidate = response.response.candidates?.[0];
    if (!candidate?.content?.parts) {
      return { success: false, error: "No response content" };
    }

    const usage = response.response.usageMetadata;
    const inputTokens = usage?.promptTokenCount ?? 0;
    const outputTokens = usage?.candidatesTokenCount ?? 0;

    // 检查是否有图片返回 (Pro 模式)
    for (const part of candidate.content.parts) {
      if (part.inlineData?.data) {
        return {
          success: true,
          outputBuffer: Buffer.from(part.inlineData.data, "base64"),
          inputTokens,
          outputTokens,
        };
      }
    }

    // 检查是否有文本返回 (Nano 模式 - 坐标检测)
    for (const part of candidate.content.parts) {
      if (part.text) {
        const boxes = parseBoxesFromText(part.text);
        if (boxes.length > 0) {
          return {
            success: true,
            boxes,
            inputTokens,
            outputTokens,
          };
        }
        // 文本但没有有效坐标
        return {
          success: false,
          error: `AI 返回文本但未检测到坐标: ${part.text.slice(0, 200)}`,
          inputTokens,
          outputTokens,
        };
      }
    }

    return { success: false, error: "Unknown response format" };
  }
}

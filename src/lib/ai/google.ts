import { GoogleGenerativeAI, type GenerateContentResult } from "@google/generative-ai";
import type { AIProvider, ProcessResult, BoundingBox } from "../types";
import type { Config } from "../config-manager";

export class GoogleProvider implements AIProvider {
  readonly name = "Google Gemini";
  readonly supportsImageEdit: boolean;

  private client: GoogleGenerativeAI;
  private modelName: string;

  constructor(config: Config) {
    this.client = new GoogleGenerativeAI(config.apiKey);
    this.modelName = config.modelName;

    // 判断是否支持原生图片编辑 (带 "image" 的模型名)
    this.supportsImageEdit = this.modelName.toLowerCase().includes("image");
  }

  async processImage(imageBuffer: Buffer, prompt: string): Promise<ProcessResult> {
    try {
      const base64 = imageBuffer.toString("base64");
      const mimeType = this.detectMimeType(imageBuffer);

      const model = this.client.getGenerativeModel({ model: this.modelName });
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
        const boxes = this.parseBoxesFromText(part.text);
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

  private parseBoxesFromText(text: string): BoundingBox[] {
    try {
      // 尝试提取 JSON 数组
      const jsonMatch = text.match(/\[[\s\S]*?\]/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) return [];

      return parsed
        .filter(
          (item) =>
            typeof item.ymin === "number" &&
            typeof item.xmin === "number" &&
            typeof item.ymax === "number" &&
            typeof item.xmax === "number"
        )
        .map((item) => ({
          ymin: item.ymin,
          xmin: item.xmin,
          ymax: item.ymax,
          xmax: item.xmax,
        }));
    } catch {
      return [];
    }
  }

  private detectMimeType(buffer: Buffer): string {
    // PNG: 89 50 4E 47
    if (buffer[0] === 0x89 && buffer[1] === 0x50) {
      return "image/png";
    }
    // JPEG: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
      return "image/jpeg";
    }
    // WebP: 52 49 46 46 ... 57 45 42 50
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[8] === 0x57) {
      return "image/webp";
    }
    return "image/png"; // 默认
  }
}

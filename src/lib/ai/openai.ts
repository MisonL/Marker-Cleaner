import OpenAI from "openai";
import type { AIProvider, ProcessResult, BoundingBox } from "../types";
import type { Config } from "../config-manager";

export class OpenAIProvider implements AIProvider {
  readonly name = "OpenAI Compatible";
  readonly supportsImageEdit = false; // OpenAI 接口通常只返回文本

  private client: OpenAI;
  private modelName: string;

  constructor(config: Config) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
    this.modelName = config.modelName;
  }

  async processImage(imageBuffer: Buffer, prompt: string): Promise<ProcessResult> {
    try {
      const base64 = imageBuffer.toString("base64");
      const mimeType = this.detectMimeType(imageBuffer);

      const response = await this.client.chat.completions.create({
        model: this.modelName,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: `data:${mimeType};base64,${base64}`,
                },
              },
              {
                type: "text",
                text: prompt,
              },
            ],
          },
        ],
        max_tokens: 1024,
      });

      return this.parseResponse(response);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private parseResponse(response: OpenAI.Chat.Completions.ChatCompletion): ProcessResult {
    const content = response.choices[0]?.message?.content;
    if (!content) {
      return { success: false, error: "No response content" };
    }

    const usage = response.usage;
    const inputTokens = usage?.prompt_tokens ?? 0;
    const outputTokens = usage?.completion_tokens ?? 0;

    // OpenAI 接口通常返回文本，尝试解析坐标
    const boxes = this.parseBoxesFromText(content);
    if (boxes.length > 0) {
      return {
        success: true,
        boxes,
        inputTokens,
        outputTokens,
      };
    }

    return {
      success: false,
      error: `AI 返回文本但未检测到坐标: ${content.slice(0, 200)}`,
      inputTokens,
      outputTokens,
    };
  }

  private parseBoxesFromText(text: string): BoundingBox[] {
    try {
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
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return "image/png";
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[8] === 0x57) return "image/webp";
    return "image/png";
  }
}

import OpenAI from "openai";
import type { Config } from "../config-manager";
import type { AIProvider, ProcessResult } from "../types";
import { detectMimeType, parseBoxesFromText } from "../utils";

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
      const mimeType = detectMimeType(imageBuffer);

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
    const boxes = parseBoxesFromText(content);
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
}

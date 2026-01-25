import OpenAI from "openai";
import type { Config } from "../config-manager";
import type { AIProvider, ProcessResult } from "../types";
import { detectMimeType, isExplicitEmptyBoxesResponse, parseBoxesFromText, sleep } from "../utils";

export class OpenAIProvider implements AIProvider {
  readonly name = "OpenAI Compatible";
  readonly supportsImageEdit = false; // OpenAI 接口通常只返回文本

  private client: OpenAI;
  private modelName: string;

  constructor(config: Config) {
    const settings = config.providerSettings.openai;
    this.client = new OpenAI({
      apiKey: settings.apiKey,
      baseURL: settings.baseUrl,
    });
    this.modelName = settings.modelName;
  }

  async processImage(imageBuffer: Buffer, prompt: string): Promise<ProcessResult> {
    try {
      const base64 = imageBuffer.toString("base64");
      const mimeType = detectMimeType(imageBuffer);

      const systemInstruction = [
        "你是一个严格的 JSON 输出器，只能输出 JSON，不能输出 Markdown、解释、注释或多余字符。",
        "你的任务：识别图片中所有人工添加的彩色矩形标记框（常见为红/橙/黄等细线框），并输出它们的边界框。",
        '输出格式必须为：{"boxes":[{"ymin":0,"xmin":0,"ymax":0,"xmax":0}]}',
        "坐标使用 0-1000 的整数：x 为横向，y 为纵向；ymin/xmin 为左上角，ymax/xmax 为右下角。",
        "必须扫描全图，不要漏掉小的/模糊的/边缘处的标记框；框尽量贴近边框线条（可略大以覆盖边缘阴影），不要过大覆盖大量内容。",
        '如果未发现标记框，输出 {"boxes":[]}。',
      ].join("\n");

      let lastError: unknown;
      const maxRetries = 3;
      let useJsonResponseFormat = true;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          if (attempt > 0) {
            const delay = Math.min(1000 * 2 ** attempt, 10000);
            await sleep(delay);
          }

          const response = await this.client.chat.completions.create(
            useJsonResponseFormat
              ? {
                  model: this.modelName,
                  messages: [
                    { role: "system", content: systemInstruction },
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
                  // Qwen3-VL-Plus 在“全图扫描+多框”场景容易输出较长，过小会导致 JSON 截断
                  max_tokens: 2048,
                  temperature: 0,
                  response_format: { type: "json_object" },
                }
              : {
                  model: this.modelName,
                  messages: [
                    { role: "system", content: systemInstruction },
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
                  max_tokens: 2048,
                  temperature: 0,
                },
          );

          return this.parseResponse(response);
          // biome-ignore lint/suspicious/noExplicitAny: error handling
        } catch (error: any) {
          // Keep any here for status/message access shorthand, or use type guard
          lastError = error;
          const status = error?.status || error?.response?.status;
          const message = error?.message || String(error);

          const responseFormatUnsupported =
            status === 400 &&
            (message.toLowerCase().includes("response_format") ||
              message.toLowerCase().includes("json_object") ||
              message.toLowerCase().includes("unsupported") ||
              message.toLowerCase().includes("not supported"));

          if (responseFormatUnsupported && useJsonResponseFormat) {
            useJsonResponseFormat = false;
            continue;
          }

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
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private parseResponse(response: OpenAI.ChatCompletion): ProcessResult {
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

    // 明确返回空结果：视为“无需清理”，交给上层保持原图
    if (isExplicitEmptyBoxesResponse(content)) {
      return {
        success: true,
        boxes: [],
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

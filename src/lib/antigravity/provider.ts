import { randomUUID } from "node:crypto";
import type { Config } from "../config-manager";
import type { AIProvider, BoundingBox, ProcessResult } from "../types";
import { detectMimeType, getPlatformInfo, parseBoxesFromText, sleep } from "../utils";
import { getAccessToken, loadToken } from "./auth";
import { ANTIGRAVITY_ENDPOINT } from "./constants";

const ENDPOINT = ANTIGRAVITY_ENDPOINT;

interface AntigravityContentPart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
}

interface AntigravityCandidate {
  content: {
    parts: AntigravityContentPart[];
  };
  finishReason?: string;
}

interface AntigravityUsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
}

interface AntigravityResponsePayload {
  response: {
    candidates: AntigravityCandidate[];
    usageMetadata: AntigravityUsageMetadata;
  };
}

export interface QuotaStatus {
  quotaRemaining?: number;
  quotaTotal?: number;
  promptCreditsRemaining?: number;
  promptCreditsTotal?: number;
  email?: string;
  tier?: string;
}

export class AntigravityProvider implements AIProvider {
  readonly name = "Antigravity";
  readonly supportsImageEdit: boolean;
  private modelName: string;

  constructor(config: Config) {
    this.modelName = config.modelName;
    // 仅当模型名称明确包含 "image" 时，才视为支持原生图像编辑
    // 其他模型 (如 gemini-3-flash, gemini-3-pro-high) 仅用于视觉检测 (Detection 模式)
    this.supportsImageEdit = this.modelName.toLowerCase().includes("image");
  }

  async processImage(imageBuffer: Buffer, prompt: string): Promise<ProcessResult> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let i = 0; i < maxRetries; i++) {
      try {
        const result = await this.doProcessImage(imageBuffer, prompt);
        // 如果是 API 返回的业务错误（比如 400 且不是瞬时的），直接返回不重试
        if (!result.success && result.error?.includes("400")) {
          return result;
        }
        if (result.success) return result;

        // 如果是其他错误，记录并重试
        lastError = new Error(result.error);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const errorMsg = lastError.message.toLowerCase();

        // 如果是 429 或者网络错误，等一下再重试
        const isRetryable =
          errorMsg.includes("429") ||
          errorMsg.includes("closed") ||
          errorMsg.includes("socket") ||
          errorMsg.includes("timeout") ||
          errorMsg.includes("50") ||
          errorMsg.includes("econnreset");

        if (isRetryable && i < maxRetries - 1) {
          const delay = 2 ** i * 1000;
          await sleep(delay);
          continue;
        }
        break;
      }
    }

    return {
      success: false,
      error: lastError?.message || "Unknown error",
    };
  }

  private async doProcessImage(imageBuffer: Buffer, prompt: string): Promise<ProcessResult> {
    const token = await getAccessToken();
    const tokenData = loadToken();

    if (!tokenData?.project_id) {
      throw new Error("Missing Project ID. Please re-login.");
    }

    const base64 = imageBuffer.toString("base64");
    const mimeType = detectMimeType(imageBuffer);
    const { platform, arch } = getPlatformInfo();

    const body = {
      project: tokenData.project_id,
      model: this.modelName || "gemini-3-pro-image",
      request: {
        contents: [
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  mimeType,
                  data: base64,
                },
              },
              { text: prompt },
            ],
          },
        ],
      },
      request_type: "agent",
      userAgent: "antigravity",
      requestId: randomUUID(),
    };

    const response = await fetch(`${ENDPOINT}/v1internal:generateContent`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": `antigravity/1.11.5 ${platform}/${arch}`,
        "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
        "Client-Metadata":
          '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMsg = `Antigravity API Error ${response.status}`;
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.error?.message) {
          errorMsg += `: ${errorJson.error.message}`;
        } else {
          errorMsg += `: ${errorText}`;
        }
      } catch {
        errorMsg += `: ${errorText}`;
      }
      throw new Error(errorMsg);
    }

    const result = (await response.json()) as AntigravityResponsePayload;
    return this.parseResponse(result);
  }

  private parseResponse(response: AntigravityResponsePayload): ProcessResult {
    const candidate = response.response?.candidates?.[0];
    if (!candidate?.content?.parts) {
      return { success: false, error: "No response content" };
    }

    const usage = response.response.usageMetadata;
    const inputTokens = usage?.promptTokenCount ?? 0;
    const outputTokens = usage?.candidatesTokenCount ?? 0;

    // 检查是否为图片 (Pro 模式)
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

    // 检查是否为文本 (Detection 模式)
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
        return {
          success: false,
          error: `AI returned text but no coordinates: ${part.text.slice(0, 200)}`,
          inputTokens,
          outputTokens,
        };
      }
    }

    return { success: false, error: "Unknown response format" };
  }
  async getQuota(): Promise<QuotaStatus | null> {
    try {
      const token = await getAccessToken();
      // 从参考仓库获取的正确端点
      const response = await fetch(
        `${ENDPOINT}/exa.language_server_pb.LanguageServerService/GetUserStatus`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        },
      );

      if (!response.ok) {
        // 配额获取失败时静默处理，避免干扰
        return null;
      }

      /* biome-ignore lint/suspicious/noExplicitAny: Complex nested API response */
      const data = (await response.json()) as { userStatus?: any; currentTier?: string };
      const status = data?.userStatus;

      // 如果有数据则映射结构
      return {
        quotaRemaining: status?.quotas?.[0]?.remainingCount,
        quotaTotal: status?.quotas?.[0]?.totalCount,
        promptCreditsRemaining: status?.promptCredits?.[0]?.remainingCount,
        promptCreditsTotal: status?.promptCredits?.[0]?.totalCount,
        email: status?.email,
        tier: data?.currentTier,
      };
    } catch (error) {
      return null;
    }
  }
}

import { createHash } from "node:crypto";

/**
 * 检测图片 MIME 类型（基于魔数）
 */
export function detectMimeType(buffer: Buffer): string {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[8] === 0x57) return "image/webp";
  return "image/png"; // 默认
}

/**
 * 从文本中解析 BoundingBox 数组
 */
export function parseBoxesFromText(text: string): Array<{
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
}> {
  try {
    const jsonMatch = text.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as unknown[];
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(
        (item): item is { ymin: number; xmin: number; ymax: number; xmax: number } =>
          typeof item === "object" &&
          item !== null &&
          "ymin" in item &&
          typeof item.ymin === "number" &&
          "xmin" in item &&
          typeof item.xmin === "number" &&
          "ymax" in item &&
          typeof item.ymax === "number" &&
          "xmax" in item &&
          typeof item.xmax === "number",
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

/**
 * 获取平台信息用于 User-Agent
 */
export function getPlatformInfo(): { platform: string; arch: string } {
  const platform =
    process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  return { platform, arch };
}

/**
 * Base64 URL 编码
 */
export function base64URLEncode(str: Buffer): string {
  return str.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * SHA256 哈希
 */
export function sha256(buffer: Buffer): Buffer {
  return createHash("sha256").update(buffer).digest();
}

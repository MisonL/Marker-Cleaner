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
 * 格式化持续时间（ms -> h m s）
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || h > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);

  return parts.join(" ");
}

/**
 * 渲染图片到终端（适配 iTerm2 原生协议，并为通用环境提供降级字符画）
 */
export function renderImageToTerminal(buffer: Buffer): string {
  // iTerm2 协议处理
  if (isIterm2()) {
    const b64 = buffer.toString("base64");
    return `\x1b]1337;File=inline=1;width=15;height=5;preserveAspectRatio=1:${b64}\x07`;
  }

  // TODO: 后续可以加入为 WezTerm/Sixel 协议的适配
  // 目前非 iTerm2 环境提供简单的标识或静默
  return "🖼️ [Image]"; 
}

/**
 * 检测是否为 iTerm2
 */
export function isIterm2(): boolean {
  return !!process.env.TERM_PROGRAM && (process.env.TERM_PROGRAM === "iTerm.app" || process.env.TERM_PROGRAM === "WezTerm");
}

/**
 * SHA256 哈希
 */
export function sha256(buffer: Buffer): Buffer {
  return createHash("sha256").update(buffer).digest();
}

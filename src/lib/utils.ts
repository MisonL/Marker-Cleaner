import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import open from "open";

/**
 * 归一化路径，处理 file:// 协议以及相对/绝对路径
 */
export function normalizePath(pathStr: string, baseDir?: string): string {
  let finalPath = (pathStr || "").trim();
  if (!finalPath) return "";

  // 处理 file:// 协议
  if (finalPath.startsWith("file://")) {
    try {
      finalPath = fileURLToPath(finalPath);
    } catch {
      // 如果 fileURLToPath 失败（非标准 URL），手动剥离协议头
      // 处理 file://C:/ 这种非标准但常见的格式
      finalPath = finalPath.replace(/^file:\/\/+(?=[a-zA-Z]:)/, "");
      finalPath = finalPath.replace(/^file:\/\/\/?/, "");

      // 对剥离后的路径再次进行绝对路径检查
      const isAbsolute =
        finalPath.startsWith("/") ||
        finalPath.match(/^[a-zA-Z]:[\\/]/) ||
        finalPath.startsWith("\\\\");
      if (isAbsolute) return finalPath;
    }
  }

  // 判定是否为绝对路径
  const isAbsolute =
    finalPath.startsWith("/") || // Unix 绝对路径
    finalPath.match(/^[a-zA-Z]:[\\/]/) || // Windows 绝对路径 (C:\ 或 C:/)
    finalPath.startsWith("\\\\"); // Windows UNC 路径

  if (isAbsolute) {
    return finalPath;
  }

  // 如果提供了基准目录，则拼接
  return baseDir ? join(baseDir, finalPath) : finalPath;
}

/**
 * 跨平台打开文件或文件夹
 */
export async function openPath(path: string): Promise<void> {
  await open(path);
}

/**
 * 检测图片 MIME 类型（基于魔数）
 */
export function detectMimeType(buffer: Buffer): string {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[8] === 0x57) return "image/webp";
  return "image/png"; // 默认
}

export function parseBoxesFromText(text: string): Array<{
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
}> {
  try {
    // 1. 提取最可能的 JSON 数组部分
    let jsonContent = "";
    const jsonMatch = text.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      jsonContent = jsonMatch[0];
    } else {
      // 尝试匹配未闭合的左括号开始的部分
      const startIndex = text.indexOf("[");
      if (startIndex !== -1) {
        jsonContent = text.slice(startIndex);
      }
    }

    if (!jsonContent) return [];

    // 2. 尝试清洗 JSON (处理可能出现的截断或多余逗号)
    let cleaned = jsonContent.trim();
    // 移除末尾可能的非 JSON 字符（如Markdown代码块结束符）
    cleaned = cleaned.replace(/`+$/, "").trim();

    // 处理截断：如果以逗号结尾，尝试移除
    if (cleaned.endsWith(",")) {
      cleaned = cleaned.slice(0, -1);
    }

    // 处理未闭合的括号
    const openBrackets = (cleaned.match(/\[/g) || []).length;
    const closeBrackets = (cleaned.match(/\]/g) || []).length;
    if (openBrackets > closeBrackets) {
      cleaned += "]".repeat(openBrackets - closeBrackets);
    }
    const openCurly = (cleaned.match(/\{/g) || []).length;
    const closeCurly = (cleaned.match(/\}/g) || []).length;
    if (openCurly > closeCurly) {
      // 检查当前最后是否正在写一个对象，如果是，补齐
      if (!cleaned.endsWith("}") && !cleaned.endsWith("]")) {
        cleaned += "}";
      }
      if ((cleaned.match(/\{/g) || []).length > (cleaned.match(/\}/g) || []).length) {
        cleaned += "}".repeat(openCurly - (cleaned.match(/\}/g) || []).length);
      }
    }

    // 再次递归修复可能的非法尾随逗号 (e.g., [...,])
    cleaned = cleaned.replace(/,\s*\]/g, "]").replace(/,\s*\}/g, "}");

    // biome-ignore lint/suspicious/noExplicitAny: recover from broken JSON
    let parsed: any[];
    try {
      parsed = JSON.parse(cleaned) as unknown[];
    } catch (e) {
      // 3. 解析失败：最后的杀手锏 - 使用正则强行提取所有像 {...} 的对象
      // biome-ignore lint/suspicious/noExplicitAny: fallback extraction
      const objects: any[] = [];
      const objectMatches = cleaned.match(/\{[\s\S]*?\}/g);
      if (objectMatches) {
        for (const objStr of objectMatches) {
          try {
            // 尝试对单个对象进行简单的闭合修复后解析
            let singleObj = objStr.trim();
            const openC = (singleObj.match(/\{/g) || []).length;
            const closeC = (singleObj.match(/\}/g) || []).length;
            if (openC > closeC) singleObj += "}".repeat(openC - closeC);
            objects.push(JSON.parse(singleObj));
          } catch {
            // 忽略单个无法解析的对象
          }
        }
      }
      if (objects.length > 0) {
        parsed = objects;
      } else {
        return [];
      }
    }

    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((item: any) => {
        // 1. 标准格式 {ymin, xmin, ymax, xmax}
        if (
          typeof item === "object" &&
          item !== null &&
          "ymin" in item &&
          "xmin" in item &&
          "ymax" in item &&
          "xmax" in item
        ) {
          return {
            ymin: Number(item.ymin),
            xmin: Number(item.xmin),
            ymax: Number(item.ymax),
            xmax: Number(item.xmax),
          };
        }
        // 2. Qwen-VL 等常用格式 {bbox_2d: [y1, x1, y2, x2]}
        if (
          typeof item === "object" &&
          item !== null &&
          "bbox_2d" in item &&
          Array.isArray(item.bbox_2d) &&
          item.bbox_2d.length === 4
        ) {
          const [ymin, xmin, ymax, xmax] = item.bbox_2d;
          return {
            ymin: Number(ymin),
            xmin: Number(xmin),
            ymax: Number(ymax),
            xmax: Number(xmax),
          };
        }
        return null;
      })
      .filter((item): item is { ymin: number; xmin: number; ymax: number; xmax: number } => {
        return (
          item !== null &&
          !Number.isNaN(item.ymin) &&
          !Number.isNaN(item.xmin) &&
          !Number.isNaN(item.ymax) &&
          !Number.isNaN(item.xmax)
        );
      });
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
  return (
    !!process.env.TERM_PROGRAM &&
    (process.env.TERM_PROGRAM === "iTerm.app" || process.env.TERM_PROGRAM === "WezTerm")
  );
}

/**
 * SHA256 哈希
 */
export function sha256(buffer: Buffer): Buffer {
  return createHash("sha256").update(buffer).digest();
}

/**
 * 等待指定毫秒数
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

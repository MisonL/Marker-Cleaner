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
    // 针对 Qwen 等模型，优先清理常见的 Markdown 包裹
    const cleanedText = text
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();

    // 1. 尝试寻找最外层的 [ ] 结构
    let jsonContent = "";
    const firstBracket = cleanedText.indexOf("[");
    const lastBracket = cleanedText.lastIndexOf("]");

    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
      jsonContent = cleanedText.slice(firstBracket, lastBracket + 1);
    } else {
      // 降级策略：如果没有数组结构，尝试寻找对象结构 { }
      const firstBrace = cleanedText.indexOf("{");
      const lastBrace = cleanedText.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        // 包装成数组处理
        jsonContent = `[${cleanedText.slice(firstBrace, lastBrace + 1)}]`;
      }
    }

    if (!jsonContent) return [];

    // 2. 尝试清洗和补全 JSON
    let cleaned = jsonContent.trim();

    // 修复常见的尾随逗号和非法字符
    cleaned = cleaned.replace(/,\s*([\]\}])/g, "$1");

    // 平衡括号补全逻辑
    const openBrackets = (cleaned.match(/\[/g) || []).length;
    const closeBrackets = (cleaned.match(/\]/g) || []).length;
    if (openBrackets > closeBrackets) {
      cleaned += "]".repeat(openBrackets - closeBrackets);
    }
    const openCurly = (cleaned.match(/\{/g) || []).length;
    const closeCurly = (cleaned.match(/\}/g) || []).length;
    if (openCurly > closeCurly) {
      cleaned += "}".repeat(openCurly - closeCurly);
    }

    // biome-ignore lint/suspicious/noExplicitAny: recover from broken JSON
    let parsed: any[];
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      // 3. 杀手锏：正则提取所有有效对象
      const objects: Array<Record<string, unknown>> = [];
      const objectRegex = /\{[^{}]*("ymin"|"xmin"|"ymax"|"xmax"|"bbox_2d")[^{}]*\}/g;
      const matches = cleaned.match(objectRegex);
      if (matches) {
        for (const m of matches) {
          try {
            // 对每个匹配到的潜在对象尝试补齐并解析
            let objStr = m.trim();
            const o = (objStr.match(/\{/g) || []).length;
            const c = (objStr.match(/\}/g) || []).length;
            if (o > c) objStr += "}".repeat(o - c);
            objects.push(JSON.parse(objStr));
          } catch {
            /* ignore */
          }
        }
      }
      if (objects.length > 0) {
        parsed = objects;
      } else {
        return [];
      }
    }

    if (!Array.isArray(parsed)) {
      parsed = [parsed]; // 强制转为数组
    }

    // 兼容：模型可能直接输出单个 bbox 数组，例如 [xmin, ymin, xmax, ymax]
    // 这时 parsed 已经是 number[]，需要包装成二维数组以走统一分支
    if (
      parsed.length >= 4 &&
      typeof parsed[0] === "number" &&
      typeof parsed[1] === "number" &&
      typeof parsed[2] === "number" &&
      typeof parsed[3] === "number"
    ) {
      parsed = [parsed];
    }

    // 坐标智能归一化 (针对 Qwen2/3-VL 常用 0-1000 坐标系)
    // 如果数值大于 2，且没有大于 1005 (允许微小溢出)，则认为是在 1000 坐标系
    const normalize = (val: number) => {
      let out = val;
      if (out > 2 && out <= 1005) out = out / 1000;
      // 防御式裁剪：避免坐标越界导致后续处理跳过/误伤
      if (out < 0) out = 0;
      if (out > 1) out = 1;
      return out;
    };

    const makeBox = (y1: number, x1: number, y2: number, x2: number) => {
      if (![y1, x1, y2, x2].every((n) => Number.isFinite(n))) return null;
      const ymin = normalize(Math.min(y1, y2));
      const ymax = normalize(Math.max(y1, y2));
      const xmin = normalize(Math.min(x1, x2));
      const xmax = normalize(Math.max(x1, x2));
      if (!(ymax > ymin && xmax > xmin)) return null;
      return { ymin, xmin, ymax, xmax };
    };

    const parseArrayBox = (arr: unknown, mode: "yx" | "xy") => {
      if (!Array.isArray(arr) || arr.length < 4) return null;
      const v = arr.slice(0, 4).map((n) => Number(n));
      if (v.some((n) => !Number.isFinite(n))) return null;
      const v1 = v[0];
      const v2 = v[1];
      const v3 = v[2];
      const v4 = v[3];
      if (v1 === undefined || v2 === undefined || v3 === undefined || v4 === undefined) return null;
      if (![v1, v2, v3, v4].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
      // yx: [ymin, xmin, ymax, xmax]
      if (mode === "yx") return makeBox(v1, v2, v3, v4);
      // xy: [xmin, ymin, xmax, ymax]
      return makeBox(v2, v1, v4, v3);
    };

    return parsed
      .flatMap((item: Record<string, unknown>) => {
        // 1) 显式键值对：必须都是可解析数字，否则降级为数组容错逻辑
        if (
          typeof item === "object" &&
          item !== null &&
          "ymin" in item &&
          "xmin" in item &&
          "ymax" in item &&
          "xmax" in item
        ) {
          const y1 = Number(item.ymin);
          const x1 = Number(item.xmin);
          const y2 = Number(item.ymax);
          const x2 = Number(item.xmax);
          const direct = makeBox(y1, x1, y2, x2);
          if (direct) return [direct];
          // 若值不是数字（例如数组），继续走数组容错分支
        }

        // 2) bbox_2d / 裸数组
        if (Array.isArray(item)) {
          const box = parseArrayBox(item, "xy");
          return box ? [box] : [];
        }
        if (typeof item === "object" && item !== null && "bbox_2d" in item) {
          const box = parseArrayBox((item as { bbox_2d: unknown }).bbox_2d, "xy");
          return box ? [box] : [];
        }

        // 3) 极端容错：模型把 bbox 数组塞进 ymin/xmin/ymax/xmax 字段（实测 qwen3-vl-plus 会这样“穿模”）
        if (typeof item === "object" && item !== null) {
          const candidates: Array<{ key: "ymin" | "xmin" | "ymax" | "xmax"; value: unknown }> = [];
          for (const key of ["ymin", "xmin", "ymax", "xmax"] as const) {
            if (key in item && Array.isArray((item as Record<string, unknown>)[key])) {
              candidates.push({ key, value: (item as Record<string, unknown>)[key] });
            }
          }

          if (candidates.length > 0) {
            const out: Array<{ ymin: number; xmin: number; ymax: number; xmax: number }> = [];
            for (const c of candidates) {
              // key 是 ymin/ymax 时，更倾向于 [ymin,xmin,ymax,xmax]
              // key 是 xmin/xmax 时，更倾向于 [xmin,ymin,xmax,ymax]
              const preferred = c.key === "ymin" || c.key === "ymax" ? "yx" : "xy";
              const box = parseArrayBox(c.value, preferred);
              if (box) out.push(box);
            }
            // 去重（避免同一个 bbox 被重复塞到多个字段时出现重复框）
            const uniq = new Map<
              string,
              { ymin: number; xmin: number; ymax: number; xmax: number }
            >();
            for (const b of out) {
              const k = `${b.ymin.toFixed(4)}:${b.xmin.toFixed(4)}:${b.ymax.toFixed(4)}:${b.xmax.toFixed(4)}`;
              uniq.set(k, b);
            }
            return Array.from(uniq.values());
          }
        }

        return [];
      })
      .filter((item): item is { ymin: number; xmin: number; ymax: number; xmax: number } => {
        return (
          item !== null &&
          !Number.isNaN(item.ymin) &&
          !Number.isNaN(item.xmin) &&
          !Number.isNaN(item.ymax) &&
          !Number.isNaN(item.xmax) &&
          item.ymax > item.ymin &&
          item.xmax > item.xmin
        );
      });
  } catch {
    return [];
  }
}

/**
 * 检测模型是否明确返回了“空检测结果”（避免把“没标记”当成任务失败）
 * 仅在内容本身就是纯 JSON（对象/数组）时返回 true，避免误判。
 */
export function isExplicitEmptyBoxesResponse(text: string): boolean {
  const cleanedText = (text || "")
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  try {
    if (cleanedText.startsWith("{") && cleanedText.endsWith("}")) {
      // biome-ignore lint/suspicious/noExplicitAny: generic JSON parse
      const obj: any = JSON.parse(cleanedText);
      const boxes = obj?.boxes;
      return Array.isArray(boxes) && boxes.length === 0;
    }

    if (cleanedText.startsWith("[") && cleanedText.endsWith("]")) {
      // biome-ignore lint/suspicious/noExplicitAny: generic JSON parse
      const arr: any = JSON.parse(cleanedText);
      return Array.isArray(arr) && arr.length === 0;
    }
  } catch {
    return false;
  }

  return false;
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

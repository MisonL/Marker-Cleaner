import type sharp from "sharp";
import { DependencyManager } from "../../deps-manager";
import type { BoundingBox } from "../../types";
import type { PixelRect } from "../rect";

export type SharpFn = typeof sharp;

/**
 * 估算图像背景纹理复杂度 (基于 Sobel 梯度)
 */
export function estimateTextureComplexity(
  pixels: Uint8Array,
  width: number,
  height: number,
): number {
  const target = 320;
  const scale = width > target ? target / width : 1;
  const dw = Math.max(8, Math.round(width * scale));
  const dh = Math.max(8, Math.round(height * scale));

  const gray = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(height - 1, Math.round(((y + 0.5) / dh) * height - 0.5));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(width - 1, Math.round(((x + 0.5) / dw) * width - 0.5));
      const idx = (sy * width + sx) * 4;
      gray[y * dw + x] =
        0.299 * (pixels[idx] ?? 0) +
        0.587 * (pixels[idx + 1] ?? 0) +
        0.114 * (pixels[idx + 2] ?? 0);
    }
  }

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
  const getG = (x: number, y: number) => gray[clamp(y, 0, dh - 1) * dw + clamp(x, 0, dw - 1)] ?? 0;

  let acc = 0;
  let cnt = 0;
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const gx =
        -getG(x - 1, y - 1) -
        2 * getG(x - 1, y) -
        getG(x - 1, y + 1) +
        getG(x + 1, y - 1) +
        2 * getG(x + 1, y) +
        getG(x + 1, y + 1);
      const gy =
        -getG(x - 1, y - 1) -
        2 * getG(x, y - 1) -
        getG(x + 1, y - 1) +
        getG(x - 1, y + 1) +
        2 * getG(x, y + 1) +
        getG(x + 1, y + 1);
      acc += Math.abs(gx) + Math.abs(gy);
      cnt++;
    }
  }
  return Math.min(100, (cnt > 0 ? acc / cnt : 0) / 12);
}

/**
 * 合并 AI 框与本地识别框
 */
export function mergeBoxes(base: BoundingBox[], extra: BoundingBox[]): BoundingBox[] {
  if (extra.length === 0) return base;
  const iou = (a: BoundingBox, b: BoundingBox) => {
    const x1 = Math.max(a.xmin, b.xmin);
    const y1 = Math.max(a.ymin, b.ymin);
    const x2 = Math.min(a.xmax, b.xmax);
    const y2 = Math.min(a.ymax, b.ymax);
    const iw = Math.max(0, x2 - x1);
    const ih = Math.max(0, y2 - y1);
    const inter = iw * ih;
    const ua = (a.xmax - a.xmin) * (a.ymax - a.ymin);
    const ub = (b.xmax - b.xmin) * (b.ymax - b.ymin);
    const union = ua + ub - inter;
    return union > 0 ? inter / union : 0;
  };

  const out = [...base];
  for (const b of extra) {
    let merged = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[i];
      if (!a) continue;
      const overlap = iou(a, b);
      const areaA = Math.max(0, (a.xmax - a.xmin) * (a.ymax - a.ymin));
      const areaB = Math.max(0, (b.xmax - b.xmin) * (b.ymax - b.ymin));
      const ratio = areaA > 0 && areaB > 0 ? Math.min(areaA, areaB) / Math.max(areaA, areaB) : 0;
      if (overlap > 0.75 || (overlap > 0.55 && ratio > 0.55)) {
        out[i] = {
          ymin: Math.min(a.ymin, b.ymin),
          xmin: Math.min(a.xmin, b.xmin),
          ymax: Math.max(a.ymax, b.ymax),
          xmax: Math.max(a.xmax, b.xmax),
        };
        merged = true;
        break;
      }
    }
    if (!merged) out.push(b);
  }
  return out;
}

/**
 * 转换归一化坐标到像素坐标并外扩
 */
export function toPixelRect(
  b: BoundingBox,
  width: number,
  height: number,
  paddingPx: number,
): PixelRect {
  const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
  const xmin = clamp01(Math.min(b.xmin, b.xmax));
  const xmax = clamp01(Math.max(b.xmin, b.xmax));
  const ymin = clamp01(Math.min(b.ymin, b.ymax));
  const ymax = clamp01(Math.max(b.ymin, b.ymax));
  return {
    x1: Math.max(0, Math.floor(xmin * width) - paddingPx),
    y1: Math.max(0, Math.floor(ymin * height) - paddingPx),
    x2: Math.min(width, Math.ceil(xmax * width) + paddingPx),
    y2: Math.min(height, Math.ceil(ymax * height) + paddingPx),
  };
}

/**
 * 转换输出格式
 */
export async function convertFormat(
  imageBuffer: Buffer,
  format: "original" | "png" | "jpg" | "webp",
  originalExt?: string,
): Promise<Buffer> {
  const ext = originalExt ? originalExt.toLowerCase() : "";
  let sharp: SharpFn;
  try {
    const sharpModule = await DependencyManager.getInstance().loadSharp();
    sharp = (sharpModule.default || sharpModule) as unknown as SharpFn;
  } catch (error) {
    if (format === "original" || !format) return imageBuffer;
    throw new Error("Sharp module is required for image format conversion.");
  }

  const image = sharp(imageBuffer).withMetadata();
  if (format === "png") return image.png().toBuffer();
  if (format === "jpg") return image.jpeg({ quality: 90 }).toBuffer();
  if (format === "webp") return image.webp({ quality: 90 }).toBuffer();

  const metadata = await image.metadata();
  const actualType = metadata.format;
  let expectedType = "unknown";
  if (ext === ".jpg" || ext === ".jpeg") expectedType = "jpeg";
  else if (ext === ".png") expectedType = "png";
  else if (ext === ".webp") expectedType = "webp";

  if (actualType === expectedType && actualType) return imageBuffer;
  if (expectedType === "jpeg") return image.jpeg({ quality: 90 }).toBuffer();
  if (expectedType === "png") return image.png().toBuffer();
  if (expectedType === "webp") return image.webp({ quality: 90 }).toBuffer();
  return imageBuffer;
}

/**
 * 获取文件扩展名
 */
export function getOutputExtension(
  format: "original" | "png" | "jpg" | "webp",
  originalExt: string,
): string {
  if (format === "original") return originalExt;
  return `.${format}`;
}

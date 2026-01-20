import sharp from "sharp";
import type { BoundingBox } from "./types";

/**
 * 使用 Sharp 在指定区域内清除彩色标记
 * 采用简单的像素替换策略：将目标区域内的高饱和度彩色像素替换为周围像素的平均值
 */
export async function cleanMarkersLocal(
  imageBuffer: Buffer,
  boxes: BoundingBox[]
): Promise<Buffer> {
  if (boxes.length === 0) {
    return imageBuffer;
  }

  const image = sharp(imageBuffer);
  const metadata = await image.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  if (width === 0 || height === 0) {
    throw new Error("无法读取图片尺寸");
  }

  // 获取原始像素数据 (RGBA)
  const { data, info } = await image.raw().ensureAlpha().toBuffer({ resolveWithObject: true });

  const pixels = new Uint8Array(data);

  for (const box of boxes) {
    // 将相对坐标转换为绝对像素坐标
    const x1 = Math.floor(box.xmin * width);
    const y1 = Math.floor(box.ymin * height);
    const x2 = Math.ceil(box.xmax * width);
    const y2 = Math.ceil(box.ymax * height);

    // 遍历区域内的每个像素
    for (let y = y1; y < y2; y++) {
      for (let x = x1; x < x2; x++) {
        const idx = (y * info.width + x) * 4;

        const r = pixels[idx] ?? 0;
        const g = pixels[idx + 1] ?? 0;
        const b = pixels[idx + 2] ?? 0;

        // 检测是否为高饱和度的红/橙/黄色
        if (isMarkerColor(r, g, b)) {
          // 使用周围像素的平均值替换
          const [avgR, avgG, avgB] = getNeighborAverage(pixels, info.width, info.height, x, y);
          pixels[idx] = avgR;
          pixels[idx + 1] = avgG;
          pixels[idx + 2] = avgB;
          // alpha 保持不变
        }
      }
    }
  }

  // 重建图片
  return sharp(pixels, {
    raw: {
      width: info.width,
      height: info.height,
      channels: 4,
    },
  })
    .withMetadata() // 尽量保留元数据
    .png()
    .toBuffer();
}

/**
 * 检测是否为标记颜色 (红/橙/黄)
 */
function isMarkerColor(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const saturation = max === 0 ? 0 : (max - min) / max;

  // 高饱和度 (> 40%)
  if (saturation < 0.4) return false;

  // 红色系: R 最大，且远大于 B
  if (r > 150 && r > g * 0.8 && r > b * 1.5) return true;

  // 橙色系: R 最大，G 次之
  if (r > 180 && g > 80 && g < 200 && b < 100) return true;

  // 黄色系: R 和 G 都高，B 低
  if (r > 180 && g > 150 && b < 100) return true;

  return false;
}

/**
 * 获取周围像素的平均值 (排除标记色)
 */
function getNeighborAverage(
  pixels: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number
): [number, number, number] {
  const neighbors: [number, number, number][] = [];

  // 扩展搜索范围，找到足够的非标记像素
  for (let radius = 1; radius <= 5; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx === 0 && dy === 0) continue;

        const nx = x + dx;
        const ny = y + dy;

        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;

        const idx = (ny * width + nx) * 4;
        const r = pixels[idx] ?? 0;
        const g = pixels[idx + 1] ?? 0;
        const b = pixels[idx + 2] ?? 0;

        if (!isMarkerColor(r, g, b)) {
          neighbors.push([r, g, b]);
        }
      }
    }

    if (neighbors.length >= 4) break;
  }

  if (neighbors.length === 0) {
    return [128, 128, 128]; // 灰色兜底
  }

  const avgR = Math.round(neighbors.reduce((s, n) => s + n[0], 0) / neighbors.length);
  const avgG = Math.round(neighbors.reduce((s, n) => s + n[1], 0) / neighbors.length);
  const avgB = Math.round(neighbors.reduce((s, n) => s + n[2], 0) / neighbors.length);

  return [avgR, avgG, avgB];
}

/**
 * 转换输出格式
 */
export async function convertFormat(
  imageBuffer: Buffer,
  format: "original" | "png" | "jpg" | "webp",
  originalExt?: string
): Promise<Buffer> {
  const ext = originalExt ? originalExt.toLowerCase() : "";
  
  // 核心优化：如果是原始输出，且扩展名匹配，直接直出 Buffer，跳过 Sharp 以保留 100% 元数据
  if (format === "original" || !format) {
      return imageBuffer;
  }

  const image = sharp(imageBuffer).withMetadata();

  switch (format) {
    case "png":
      return image.png().toBuffer();
    case "jpg":
      return image.jpeg({ quality: 90 }).toBuffer();
    case "webp":
      return image.webp({ quality: 90 }).toBuffer();
    default:
      return imageBuffer;
  }
}

/**
 * 获取文件扩展名
 */
export function getOutputExtension(format: "original" | "png" | "jpg" | "webp", originalExt: string): string {
  if (format === "original") {
    return originalExt;
  }
  return `.${format}`;
}

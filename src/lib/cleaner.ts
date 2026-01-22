// import sharp from "sharp"; // Removed top-level import to prevent startup crash if missing
import type { BoundingBox } from "./types";
import { DependencyManager } from "./deps-manager"; // Added import

/**
 * 使用 Sharp 在指定区域内清除彩色标记
 * 采用简单的像素替换策略：将目标区域内的高饱和度彩色像素替换为周围像素的平均值
 */
export async function cleanMarkersLocal(
  imageBuffer: Buffer,
  boxes: BoundingBox[],
): Promise<Buffer> {
  if (boxes.length === 0) {
    return imageBuffer;
  }

  // Dynamic import sharp via DependencyManager
  let sharp;
  try {
    const sharpModule = await DependencyManager.getInstance().loadSharp();
    sharp = sharpModule.default || sharpModule;
  } catch (error) {
    throw new Error(
      "Sharp module not found. Please ensure 'sharp' is installed alongside the executable or use Native mode which doesn't require local processing.",
    );
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
    // 将相对坐标转换为绝对像素坐标，并裁剪到图片边界
    const x1 = Math.max(0, Math.floor(box.xmin * width));
    const y1 = Math.max(0, Math.floor(box.ymin * height));
    const x2 = Math.min(width, Math.ceil(box.xmax * width));
    const y2 = Math.min(height, Math.ceil(box.ymax * height));

    // 跳过无效区域
    if (x1 >= x2 || y1 >= y2) continue;

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
 * 检测是否为标记颜色 (红/橙/黄/蓝等高饱和度识别色)
 */
function isMarkerColor(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const saturation = max === 0 ? 0 : delta / max;

  // 1. 低饱和度排除 (确保是鲜艳的彩色，而非灰白黑)
  if (saturation < 0.45) return false;

  // 2. 亮度判定 (排除极暗的颜色)
  if (max < 40) return false;

  // 3. 色相粗略判定 (基于 RGB 关系)
  // 红色/橙色范围: R 占绝对优势
  if (r > g * 1.2 && r > b * 1.5) {
    return true;
  }

  // 黄色范围: R 和 G 都高，B 低
  if (r > 150 && g > 150 && b < 120 && Math.abs(r - g) < 60) {
    return true;
  }

  // 蓝色范围 (新增建议): B 占优势
  if (b > r * 1.5 && b > g * 1.2) {
    return true;
  }

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
  y: number,
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
  originalExt?: string,
): Promise<Buffer> {
  const ext = originalExt ? originalExt.toLowerCase() : "";

  // Dynamic import sharp via DependencyManager
  let sharp;
  try {
    const sharpModule = await DependencyManager.getInstance().loadSharp();
    sharp = sharpModule.default || sharpModule;
  } catch (error) {
    // Graceful fallback for "original" mode if sharp is missing
    // We assume the buffer is valid and return it as is.
    if (format === "original" || !format) {
      return imageBuffer;
    }
    throw new Error(
      "Sharp module is required for image format conversion. Please ensure it is installed alongside the executable.",
    );
  }

  const image = sharp(imageBuffer).withMetadata();

  // If explicit format is requested
  if (format === "png") return image.png().toBuffer();
  if (format === "jpg") return image.jpeg({ quality: 90 }).toBuffer();
  if (format === "webp") return image.webp({ quality: 90 }).toBuffer();

  // "original" format logic with verification
  const metadata = await image.metadata();
  const actualType = metadata.format; // sharp returns 'jpeg', 'png', 'webp' etc.

  let expectedType = "unknown";
  if (ext === ".jpg" || ext === ".jpeg") expectedType = "jpeg";
  else if (ext === ".png") expectedType = "png";
  else if (ext === ".webp") expectedType = "webp";

  // If actual matches expected, return original buffer (zero loss)
  if (actualType === expectedType && actualType) {
    return imageBuffer;
  }

  // Mismatch or unknown: Force transcode to match extension
  if (expectedType === "jpeg") return image.jpeg({ quality: 90 }).toBuffer();
  if (expectedType === "png") return image.png().toBuffer();
  if (expectedType === "webp") return image.webp({ quality: 90 }).toBuffer();

  // Fallback
  return imageBuffer;
}

/**
 * 获取文件扩展名
 */
export function getOutputExtension(
  format: "original" | "png" | "jpg" | "webp",
  originalExt: string,
): string {
  if (format === "original") {
    return originalExt;
  }
  return `.${format}`;
}

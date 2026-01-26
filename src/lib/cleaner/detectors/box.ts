import type { BoundingBox } from "../../types";
import { CLEANER_THRESHOLDS } from "../constants";
import type { CleanerContext } from "../core/context";
import { isLineColor, isOverlayRed } from "../utils/color";

/**
 * 闭合矩形框本地识别
 */
export async function detectRectangleLineBoxes(ctx: CleanerContext): Promise<BoundingBox[]> {
  const { pixels, width, height, info, sharp } = ctx;
  const targetWidth = 480;
  const small = await sharp(pixels, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .resize({ width: targetWidth, withoutEnlargement: true, kernel: sharp.kernel.nearest })
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });

  const sw = small.info.width;
  const sh = small.info.height;
  if (!sw || !sh) return [];

  const d = new Uint8Array(small.data);
  const color = new Uint8Array(sw * sh);

  for (let i = 0; i < sw * sh; i++) {
    const idx = i * 4;
    if (isLineColor(d[idx] ?? 0, d[idx + 1] ?? 0, d[idx + 2] ?? 0)) color[i] = 1;
  }

  const visited = new Uint8Array(sw * sh);
  const boxes: BoundingBox[] = [];
  for (let i = 0; i < sw * sh; i++) {
    if (color[i] === 0 || visited[i] === 1) continue;
    visited[i] = 1;
    const stack = [i];
    const pts: number[] = [];
    let minx = sw;
    let miny = sh;
    let maxx = 0;
    let maxy = 0;
    while (stack.length > 0) {
      const p = stack.pop();
      if (p === undefined) break;
      pts.push(p);
      const x = p % sw;
      const y = Math.floor(p / sw);
      if (x < minx) minx = x;
      if (y < miny) miny = y;
      if (x > maxx) maxx = x;
      if (y > maxy) maxy = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= sh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= sw) continue;
          const np = ny * sw + nx;
          if (color[np] === 1 && visited[np] === 0) {
            visited[np] = 1;
            stack.push(np);
          }
        }
      }
    }
    const bw = maxx - minx + 1;
    const bh = maxy - miny + 1;
    // Lower threshold to 10 (approx 26px on 1280w)
    if (bw > 10 && bh > 10 && bw < sw * 0.9 && bh < sh * 0.9) {
      const fill = pts.length / (bw * bh);
      // 原逻辑: if (fill > 0.04 && fill < 0.35)
      // 修复: 对于小尺寸框 (Solid Price Tags)，允许高填充率
      const isSmall = bw < sw * 0.5 && bh < sh * 0.5;
      const maxFill = isSmall ? 0.95 : 0.35;
      
      if (fill > 0.04 && fill < maxFill)
        boxes.push({ ymin: miny / sh, xmin: minx / sw, ymax: maxy / sh, xmax: maxx / sw });
    }
  }
  return boxes;
}

/**
 * 叠加笔迹框识别 (覆盖模式)
 */
export async function detectOverlayLineBoxes(ctx: CleanerContext): Promise<BoundingBox[]> {
  const { pixels, width, height, info, sharp } = ctx;
  const small = await sharp(pixels, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .resize({ width: 320, withoutEnlargement: true, kernel: sharp.kernel.nearest })
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });

  const sw = small.info.width;
  const sh = small.info.height;
  if (!sw || !sh) return [];

  const d = new Uint8Array(small.data);
  const color = new Uint8Array(sw * sh);
  for (let i = 0; i < sw * sh; i++) {
    const idx = i * 4;
    if (isOverlayRed(d[idx] ?? 0, d[idx + 1] ?? 0, d[idx + 2] ?? 0)) color[i] = 1;
  }

  const visited = new Uint8Array(sw * sh);
  const boxes: BoundingBox[] = [];
  for (let i = 0; i < sw * sh; i++) {
    if (color[i] === 0 || visited[i] === 1) continue;
    visited[i] = 1;
    const stack = [i];
    const pts: number[] = [];
    let minx = sw;
    let miny = sh;
    let maxx = 0;
    let maxy = 0;
    while (stack.length > 0) {
      const p = stack.pop();
      if (p === undefined) break;
      pts.push(p);
      const x = p % sw;
      const y = Math.floor(p / sw);
      if (x < minx) minx = x;
      if (y < miny) miny = y;
      if (x > maxx) maxx = x;
      if (y > maxy) maxy = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= sh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= sw) continue;
          const np = ny * sw + nx;
          if (color[np] === 1 && visited[np] === 0) {
            visited[np] = 1;
            stack.push(np);
          }
        }
      }
    }
    const bw = maxx - minx + 1;
    const bh = maxy - miny + 1;
    const area = pts.length;
    // Lower threshold to 8 (approx 32px on 1280w)
    if (bw > 8 && bh > 8 && area > 64 && area < sw * sh * 0.2) {
      boxes.push({ ymin: miny / sh, xmin: minx / sw, ymax: maxy / sh, xmax: maxx / sw });
    }
  }
  return boxes;
}

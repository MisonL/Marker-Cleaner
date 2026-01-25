import { CLEANER_THRESHOLDS } from "../constants";
import { isLineColor, isOverlayRed } from "../utils/color";
import type { CleanerContext } from "../core/context";
import type { BoundingBox } from "../../types";

/**
 * 闭合矩形框本地识别
 */
export async function detectRectangleLineBoxes(ctx: CleanerContext): Promise<BoundingBox[]> {
  const { pixels, width, height, info, sharp } = ctx;
  const targetWidth = 480;
  const small = await sharp(pixels, { raw: { width: info.width, height: info.height, channels: 4 } })
    .resize({ width: targetWidth, withoutEnlargement: true, kernel: sharp.kernel.nearest })
    .raw().ensureAlpha().toBuffer({ resolveWithObject: true });

  const sw = small.info.width, sh = small.info.height;
  if (!sw || !sh) return [];

  const d = new Uint8Array(small.data), color = new Uint8Array(sw * sh);

  for (let i = 0; i < sw * sh; i++) {
    const idx = i * 4;
    if (isLineColor(d[idx]??0, d[idx+1]??0, d[idx+2]??0)) color[i] = 1;
  }

  const visited = new Uint8Array(sw * sh), boxes: BoundingBox[] = [];
  for (let i = 0; i < sw * sh; i++) {
    if (color[i] === 0 || visited[i] === 1) continue;
    visited[i] = 1;
    const stack = [i], pts: number[] = [];
    let minx = sw, miny = sh, maxx = 0, maxy = 0;
    while (stack.length > 0) {
      const p = stack.pop()!; pts.push(p);
      const x = p % sw, y = Math.floor(p / sw);
      if (x < minx) minx = x; if (y < miny) miny = y; if (x > maxx) maxx = x; if (y > maxy) maxy = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy; if (ny < 0 || ny >= sh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx; if (nx < 0 || nx >= sw) continue;
          const np = ny * sw + nx; if (color[np] === 1 && visited[np] === 0) { visited[np] = 1; stack.push(np); }
        }
      }
    }
    const bw = maxx - minx + 1, bh = maxy - miny + 1;
    if (bw > 25 && bh > 25 && bw < sw * 0.9 && bh < sh * 0.9) {
      const fill = pts.length / (bw * bh);
      if (fill > 0.04 && fill < 0.35) boxes.push({ ymin: miny/sh, xmin: minx/sw, ymax: maxy/sh, xmax: maxx/sw });
    }
  }
  return boxes;
}

/**
 * 叠加笔迹框识别 (覆盖模式)
 */
export async function detectOverlayLineBoxes(ctx: CleanerContext): Promise<BoundingBox[]> {
  const { pixels, width, height, info, sharp } = ctx;
  const small = await sharp(pixels, { raw: { width: info.width, height: info.height, channels: 4 } })
    .resize({ width: 320, withoutEnlargement: true, kernel: sharp.kernel.nearest })
    .raw().ensureAlpha().toBuffer({ resolveWithObject: true });

  const sw = small.info.width, sh = small.info.height;
  if (!sw || !sh) return [];

  const d = new Uint8Array(small.data), color = new Uint8Array(sw * sh);
  for (let i = 0; i < sw * sh; i++) {
    const idx = i * 4;
    if (isOverlayRed(d[idx]??0, d[idx+1]??0, d[idx+2]??0)) color[i] = 1;
  }

  const visited = new Uint8Array(sw * sh), boxes: BoundingBox[] = [];
  for (let i = 0; i < sw * sh; i++) {
    if (color[i] === 0 || visited[i] === 1) continue;
    visited[i] = 1;
    const stack = [i], pts = [];
    let minx = sw, miny = sh, maxx = 0, maxy = 0;
    while (stack.length > 0) {
      const p = stack.pop()!; pts.push(p);
      const x = p % sw, y = Math.floor(p / sw);
      if (x < minx) minx = x; if (y < miny) miny = y; if (x > maxx) maxx = x; if (y > maxy) maxy = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy; if (ny < 0 || ny >= sh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx; if (nx < 0 || nx >= sw) continue;
          const np = ny * sw + nx; if (color[np] === 1 && visited[np] === 0) { visited[np] = 1; stack.push(np); }
        }
      }
    }
    const bw = maxx - minx + 1, bh = maxy - miny + 1, area = pts.length;
    if (bw > 20 && bh > 20 && area > 100 && area < sw * sh * 0.2) {
      boxes.push({ ymin: miny/sh, xmin: minx/sw, ymax: maxy/sh, xmax: maxx/sw });
    }
  }
  return boxes;
}

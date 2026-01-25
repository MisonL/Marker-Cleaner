import type { BoundingBox } from "../../types";
import { CLEANER_THRESHOLDS } from "../constants";
import type { CleanerContext } from "../core/context";
import { isMarkerColor, isMarkerLike, isStrongMarkColorForCorner } from "../utils/color";

/**
 * 连通线框检测 (专治漏检/框偏移)
 */
export async function detectCornerConnectedLineMask(
  ctx: CleanerContext,
  roiRects?: Array<{ x1: number; y1: number; x2: number; y2: number }>,
): Promise<Uint8Array> {
  const { pixels, width, height, info, sharp } = ctx;
  const targetWidth = width >= 2000 ? 960 : 720;
  const small = await sharp(pixels, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .resize({
      width: targetWidth,
      withoutEnlargement: true,
      kernel: sharp.kernel.nearest,
      fastShrinkOnLoad: false,
    })
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });

  const sw = small.info.width;
  const sh = small.info.height;
  if (!sw || !sh) return new Uint8Array(width * height);

  const scaleX = width / sw;
  const scaleY = height / sh;
  const d = new Uint8Array(small.data);
  const color = new Uint8Array(sw * sh);

  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const idx = (y * sw + x) * 4;
      if (isMarkerColor(d[idx] ?? 0, d[idx + 1] ?? 0, d[idx + 2] ?? 0)) color[y * sw + x] = 1;
    }
  }

  const horiz = new Uint8Array(sw * sh);
  const vert = new Uint8Array(sw * sh);
  const minRun = 8;

  for (let y = 0; y < sh; y++) {
    let run = 0;
    let start = 0;
    for (let x = 0; x < sw; x++) {
      const on = color[y * sw + x] === 1;
      if (on) {
        if (run === 0) start = x;
        run++;
      }
      if (!on || x === sw - 1) {
        if (run >= minRun) {
          const end = on && x === sw - 1 ? x : x - 1;
          for (let xx = start; xx <= end; xx++) horiz[y * sw + xx] = 1;
        }
        run = on ? run : 0;
      }
    }
  }

  for (let x = 0; x < sw; x++) {
    let run = 0;
    let start = 0;
    for (let y = 0; y < sh; y++) {
      const on = color[y * sw + x] === 1;
      if (on) {
        if (run === 0) start = y;
        run++;
      }
      if (!on || y === sh - 1) {
        if (run >= minRun) {
          const end = on && y === sh - 1 ? y : y - 1;
          for (let yy = start; yy <= end; yy++) vert[yy * sw + x] = 1;
        }
        run = on ? run : 0;
      }
    }
  }

  const line = new Uint8Array(sw * sh);
  for (let i = 0; i < line.length; i++) if (horiz[i] === 1 || vert[i] === 1) line[i] = 1;

  const seed = new Uint8Array(sw * sh);
  const r = 4;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const idx = y * sw + x;
      if (line[idx] === 0) continue;
      let hasH = horiz[idx] === 1;
      let hasV = vert[idx] === 1;
      if (!(hasH && hasV)) {
        for (let dy = -r; dy <= r && !(hasH && hasV); dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= sh) continue;
          for (let dx = -r; dx <= r; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= sw) continue;
            const nidx = ny * sw + nx;
            if (
              isStrongMarkColorForCorner(
                d[nidx * 4] ?? 0,
                d[nidx * 4 + 1] ?? 0,
                d[nidx * 4 + 2] ?? 0,
              )
            ) {
              hasH = hasH || horiz[nidx] === 1;
              hasV = hasV || vert[nidx] === 1;
            }
            if (hasH && hasV) break;
          }
        }
      }
      if (hasH && hasV) seed[idx] = 1;
    }
  }

  const visited = new Uint8Array(sw * sh);
  const outSmall = new Uint8Array(sw * sh);
  const stack: number[] = [];
  for (let i = 0; i < seed.length; i++)
    if (seed[i] === 1) {
      visited[i] = 1;
      stack.push(i);
      outSmall[i] = 1;
    }
  while (stack.length > 0) {
    const p = stack.pop();
    if (p === undefined) break;
    const x = p % sw;
    const y = Math.floor(p / sw);
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= sh) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= sw) continue;
        const np = ny * sw + nx;
        if (visited[np] === 1 || line[np] === 0) continue;
        visited[np] = 1;
        outSmall[np] = 1;
        stack.push(np);
      }
    }
    if (stack.length > 200000) break;
  }

  const outDil = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (outSmall[y * sw + x] === 0) continue;
      for (let dy = -2; dy <= 2; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= sh) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= sw) continue;
          outDil[ny * sw + nx] = 1;
        }
      }
    }
  }

  const keep = new Uint8Array(sw * sh);
  const visited2 = new Uint8Array(sw * sh);
  const border = 2;
  const maxArea = Math.round(sw * sh * CLEANER_THRESHOLDS.MAX_COMPONENT_AREA_RATIO);
  for (let i = 0; i < outDil.length; i++) {
    if (outDil[i] === 0 || visited2[i] === 1) continue;
    visited2[i] = 1;
    const s2: number[] = [i];
    const pts: number[] = [];
    let minx = sw;
    let miny = sh;
    let maxx = 0;
    let maxy = 0;
    let area = 0;
    while (s2.length > 0) {
      const p = s2.pop();
      if (p === undefined) break;
      pts.push(p);
      area++;
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
          if (outDil[np] === 0 || visited2[np] === 1) continue;
          visited2[np] = 1;
          s2.push(np);
        }
      }
      if (area > 200000) break;
    }
    const bw = maxx - minx + 1;
    const bh = maxy - miny + 1;
    if (bw <= 0 || bh <= 0 || area > maxArea) continue;
    if (minx <= border || miny <= border || maxx >= sw - 1 - border || maxy >= sh - 1 - border)
      continue;
    if ((bw > sw * 0.7 && bh < sh * 0.12) || (bh > sh * 0.7 && bw < sw * 0.12)) continue;
    if (area / (bw * bh) > CLEANER_THRESHOLDS.MAX_FILL_RATIO) continue;
    for (const p of pts) keep[p] = 1;
  }

  const inRoi = (x: number, y: number) => {
    if (!roiRects || roiRects.length === 0) return true;
    for (const r of roiRects) if (x >= r.x1 && x < r.x2 && y >= r.y1 && y < r.y2) return true;
    return false;
  };

  const mask = new Uint8Array(width * height);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (keep[y * sw + x] === 0) continue;
      const ox = Math.max(0, Math.min(width - 1, Math.round((x + 0.5) * scaleX - 0.5)));
      const oy = Math.max(0, Math.min(height - 1, Math.round((y + 0.5) * scaleY - 0.5)));
      if (!inRoi(ox, oy)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        const ny = oy + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const nx = ox + dx;
          if (nx < 0 || nx >= width) continue;
          if (inRoi(nx, ny)) mask[ny * width + nx] = 1;
        }
      }
    }
  }
  return mask;
}

/**
 * 通用笔迹掩码检测
 */
export async function detectStrokeMask(
  ctx: CleanerContext,
  roiRects?: Array<{ x1: number; y1: number; x2: number; y2: number }>,
): Promise<Uint8Array> {
  const { pixels, width, height, info, isComplexScene, sharp } = ctx;
  const targetWidth = width >= 2000 ? 960 : 720;
  const small = await sharp(pixels, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .resize({ width: targetWidth, withoutEnlargement: true, kernel: sharp.kernel.nearest })
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });

  const sw = small.info.width;
  const sh = small.info.height;
  if (!sw || !sh) return new Uint8Array(width * height);

  const scaleX = width / sw;
  const scaleY = height / sh;
  const d = new Uint8Array(small.data);
  const color = new Uint8Array(sw * sh);
  for (let i = 0; i < sw * sh; i++) {
    const idx = i * 4;
    if (isMarkerLike(d[idx] ?? 0, d[idx + 1] ?? 0, d[idx + 2] ?? 0, isComplexScene)) color[i] = 1;
  }

  const visited = new Uint8Array(sw * sh);
  const keep = new Uint8Array(sw * sh);
  const maxArea = Math.round(sw * sh * (isComplexScene ? 0.05 : 0.15));
  for (let i = 0; i < sw * sh; i++) {
    if (color[i] === 0 || visited[i] === 1) continue;
    visited[i] = 1;
    const stack: number[] = [i];
    const pts: number[] = [];
    let area = 0;
    let minx = sw;
    let miny = sh;
    let maxx = 0;
    let maxy = 0;
    while (stack.length > 0) {
      const p = stack.pop();
      if (p === undefined) break;
      pts.push(p);
      area++;
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
      if (area > 100000) break;
    }
    const bw = maxx - minx + 1;
    const bh = maxy - miny + 1;
    if (area > 12 && area < maxArea && area / (bw * bh) < CLEANER_THRESHOLDS.STROKE_MAX_FILL) {
      for (const p of pts) keep[p] = 1;
    }
  }

  const inRoi = (x: number, y: number) => {
    if (!roiRects || roiRects.length === 0) return true;
    for (const r of roiRects) if (x >= r.x1 && x < r.x2 && y >= r.y1 && y < r.y2) return true;
    return false;
  };

  const mask = new Uint8Array(width * height);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (keep[y * sw + x] === 0) continue;
      const ox = Math.round((x + 0.5) * scaleX - 0.5);
      const oy = Math.round((y + 0.5) * scaleY - 0.5);
      if (!inRoi(ox, oy)) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = oy + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = ox + dx;
          if (nx < 0 || nx >= width) continue;
          if (inRoi(nx, ny)) mask[ny * width + nx] = 1;
        }
      }
    }
  }
  return mask;
}

/**
 * AI 框内的边缘检测掩码
 */
export function detectEdgeMaskInBoxes(
  ctx: CleanerContext,
  boxes: BoundingBox[],
  padPx: number,
  gradThreshold: number,
): Uint8Array {
  const { pixels, width, height } = ctx;
  const mask = new Uint8Array(width * height);
  const total = width * height;

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
  const getGray = (x: number, y: number) => {
    const idx = (clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)) * 4;
    return (
      0.299 * (pixels[idx] ?? 0) + 0.587 * (pixels[idx + 1] ?? 0) + 0.114 * (pixels[idx + 2] ?? 0)
    );
  };

  for (const b of boxes) {
    const x1 = Math.max(0, Math.floor(b.xmin * width) - padPx);
    const y1 = Math.max(0, Math.floor(b.ymin * height) - padPx);
    const x2 = Math.min(width, Math.ceil(b.xmax * width) + padPx);
    const y2 = Math.min(height, Math.ceil(b.ymax * height) + padPx);

    for (let y = y1; y < y2; y++) {
      for (let x = x1; x < x2; x++) {
        const gx =
          -getGray(x - 1, y - 1) +
          getGray(x + 1, y - 1) -
          2 * getGray(x - 1, y) +
          2 * getGray(x + 1, y) -
          getGray(x - 1, y + 1) +
          getGray(x + 1, y + 1);
        const gy =
          -getGray(x - 1, y - 1) -
          2 * getGray(x, y - 1) -
          getGray(x + 1, y - 1) +
          getGray(x - 1, y + 1) +
          2 * getGray(x, y + 1) +
          getGray(x + 1, y + 1);
        if (Math.abs(gx) + Math.abs(gy) > gradThreshold) mask[y * width + x] = 1;
      }
    }
  }
  return mask;
}

import { CLEANER_THRESHOLDS } from "../constants";
import { isLikelyMarkPixel } from "../utils/color";
import type { CleanerContext } from "./context";

/**
 * 在 Context 上执行插值修复
 */
export function inpaintMask(ctx: CleanerContext, mask: Uint8Array): number {
  const { pixels, changed, width, height, info } = ctx;
  const indices: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 1) indices.push(i);
  }
  if (indices.length === 0) return 0;

  let fallbackCount = 0;

  const sampleAt = (x: number, y: number) => {
    const idx = (y * info.width + x) * 4;
    return [pixels[idx] ?? 0, pixels[idx + 1] ?? 0, pixels[idx + 2] ?? 0] as const;
  };

  for (let pass = 0; pass < 4; pass++) {
    let progressed = 0;
    for (const p of indices) {
      if (mask[p] === 0) continue;
      const x = p % width;
      const y = Math.floor(p / width);

      const samples: Array<[number, number, number]> = [];
      for (let radius = 1; radius <= 12 && samples.length < 10; radius++) {
        const candidates: Array<[number, number]> = [
          [x, y - radius],
          [x, y + radius],
          [x - radius, y],
          [x + radius, y],
          [x - radius, y - radius],
          [x + radius, y - radius],
          [x - radius, y + radius],
          [x + radius, y + radius],
        ];
        for (const [cx, cy] of candidates) {
          if (cx < 0 || cx >= width || cy < 0 || cy >= height) continue;
          const midx = cy * width + cx;
          if (mask[midx] === 1) continue;
          const [r, g, b] = sampleAt(cx, cy);
          if (isLikelyMarkPixel(r, g, b)) continue;
          samples.push([r, g, b]);
          if (samples.length >= 6) break;
        }
      }

      const [s0, s1] = samples;
      if (samples.length >= 2 && s0 && s1) {
        let minR = 255, minG = 255, minB = 255;
        let maxR = 0, maxG = 0, maxB = 0;
        for (const [rr, gg, bb] of samples) {
          if (rr < minR) minR = rr;
          if (gg < minG) minG = gg;
          if (bb < minB) minB = bb;
          if (rr > maxR) maxR = rr;
          if (gg > maxG) maxG = gg;
          if (bb > maxB) maxB = bb;
        }
        const rangeSum = maxR - minR + (maxG - minG) + (maxB - minB);
        if (
          (samples.length >= 3 && rangeSum > CLEANER_THRESHOLDS.INPAINT_SAMPLE_RANGE_3) ||
          (samples.length === 2 && rangeSum > CLEANER_THRESHOLDS.INPAINT_SAMPLE_RANGE_2)
        ) {
          continue;
        }

        const sr = Math.round(samples.reduce((s, v) => s + v[0], 0) / samples.length);
        const sg = Math.round(samples.reduce((s, v) => s + v[1], 0) / samples.length);
        const sb = Math.round(samples.reduce((s, v) => s + v[2], 0) / samples.length);
        const idx = (y * info.width + x) * 4;
        pixels[idx] = sr;
        pixels[idx + 1] = sg;
        pixels[idx + 2] = sb;
        changed[p] = 1;
        mask[p] = 0;
        progressed++;
      }
    }
    if (progressed === 0) break;
  }

  // Fallback pass
  for (const p of indices) {
    if (mask[p] === 0) continue;
    const x = p % width;
    const y = Math.floor(p / width);
    let sr = 0, sg = 0, sb = 0, count = 0;
    for (let dy = -2; dy <= 2; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        if (mask[ny * width + nx] === 0) {
          const [r, g, b] = sampleAt(nx, ny);
          if (!isLikelyMarkPixel(r, g, b)) {
            sr += r; sg += g; sb += b;
            count++;
          }
        }
      }
    }
    if (count > 0) {
      const idx = (y * info.width + x) * 4;
      pixels[idx] = Math.round(sr / count);
      pixels[idx + 1] = Math.round(sg / count);
      pixels[idx + 2] = Math.round(sb / count);
      mask[p] = 0;
      changed[p] = 1;
      fallbackCount++;
    }
  }
  return fallbackCount;
}

/**
 * 平滑处理改动区域
 */
export function smoothChangedPixels(ctx: CleanerContext) {
  const { pixels, changed, width, height, isComplexScene } = ctx;
  const total = width * height;
  let changedCount = 0;
  for (let i = 0; i < changed.length; i++) changedCount += changed[i] ? 1 : 0;
  if (changedCount === 0) return;

  const ratio = changedCount / total;
  if (ratio > 0.35) return;

  let iterations = isComplexScene ? 1 : 2;
  if (ratio > 0.15) iterations = 1;

  for (let iter = 0; iter < iterations; iter++) {
    const src = pixels.slice();
    for (let p = 0; p < changed.length; p++) {
      if (changed[p] === 0) continue;
      const x = p % width;
      const y = Math.floor(p / width);

      let accR = 0, accG = 0, accB = 0, wsum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const np = ny * width + nx;
          const w = np === p ? 1 : changed[np] === 0 ? 2 : 1;
          const idx = np * 4;
          accR += (src[idx] ?? 0) * w;
          accG += (src[idx + 1] ?? 0) * w;
          accB += (src[idx + 2] ?? 0) * w;
          wsum += w;
        }
      }

      if (wsum > 0) {
        const outIdx = p * 4;
        pixels[outIdx] = Math.round(accR / wsum);
        pixels[outIdx + 1] = Math.round(accG / wsum);
        pixels[outIdx + 2] = Math.round(accB / wsum);
      }
    }
  }
}

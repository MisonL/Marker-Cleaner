import type { BoundingBox } from "../../types";
import {
  getDirectionalAverage,
  isLikelyMarkPixel,
  isMarkerColor,
  isOverlayLikeStrong,
  isStrongMarkColorForInpaint,
} from "../utils/color";
import { toPixelRect } from "../utils/image";
import type { CleanerContext } from "./context";
import { inpaintMask } from "./inpaint";

/**
 * 获取邻域均值 (用于无法插值时的兜底)
 */
export function getNeighborAverage(
  pixels: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): [number, number, number] {
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let sc = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= height) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      if (nx < 0 || nx >= width || (nx === x && ny === y)) continue;
      const idx = (ny * width + nx) * 4;
      sr += pixels[idx] ?? 0;
      sg += pixels[idx + 1] ?? 0;
      sb += pixels[idx + 2] ?? 0;
      sc++;
    }
  }
  if (sc === 0)
    return [
      pixels[(y * width + x) * 4] ?? 0,
      pixels[(y * width + x) * 4 + 1] ?? 0,
      pixels[(y * width + x) * 4 + 2] ?? 0,
    ];
  return [Math.round(sr / sc), Math.round(sg / sc), Math.round(sb / sc)];
}

/**
 * 评分候选框边缘的标记色浓度
 */
export function scoreFrameMarkerPixels(
  ctx: CleanerContext,
  rect: { x1: number; y1: number; x2: number; y2: number },
  band: number,
  step = 3,
): number {
  const { pixels, info } = ctx;
  const { x1, y1, x2, y2 } = rect;
  const w = x2 - x1;
  const h = y2 - y1;
  if (w <= 0 || h <= 0) return 0;
  const b = Math.max(1, Math.min(band, Math.floor(Math.min(w, h) / 2)));
  let score = 0;
  const countIfMarker = (x: number, y: number) => {
    const idx = (y * info.width + x) * 4;
    if (isMarkerColor(pixels[idx] ?? 0, pixels[idx + 1] ?? 0, pixels[idx + 2] ?? 0)) score++;
  };
  for (let y = y1; y < Math.min(y1 + b, y2); y += step) {
    for (let x = x1; x < x2; x += step) countIfMarker(x, y);
  }
  for (let y = Math.max(y2 - b, y1); y < y2; y += step) {
    for (let x = x1; x < x2; x += step) countIfMarker(x, y);
  }
  for (let y = y1 + b; y < y2 - b; y += step) {
    for (let x = x1; x < Math.min(x1 + b, x2); x += step) countIfMarker(x, y);
    for (let x = Math.max(x2 - b, x1); x < x2; x += step) countIfMarker(x, y);
  }
  return score;
}

/**
 * 涂抹矩形框边框带
 */
export function paintRectFrame(
  ctx: CleanerContext,
  rect: { x1: number; y1: number; x2: number; y2: number },
  band: number,
  options?: { force?: boolean; conservative?: boolean },
) {
  const { pixels, changed, width, height, info } = ctx;
  const { x1, y1, x2, y2 } = rect;
  const w = x2 - x1;
  const h = y2 - y1;
  if (w <= 0 || h <= 0) return;

  const b = Math.max(1, Math.min(band, Math.floor(Math.min(w, h) / 2)));
  const conservative = !!options?.conservative;
  const outlierDiffThreshold = conservative ? 96 : 84;

  const maxRunInRow = (yy: number, step = 2) => {
    let best = 0;
    let cur = 0;
    for (let x = x1; x < x2; x += step) {
      const idx = (yy * info.width + x) * 4;
      if (isLikelyMarkPixel(pixels[idx] ?? 0, pixels[idx + 1] ?? 0, pixels[idx + 2] ?? 0)) {
        cur += step;
        if (cur > best) best = cur;
      } else cur = 0;
    }
    return best;
  };

  const maxRunInCol = (xx: number, step = 2) => {
    let best = 0;
    let cur = 0;
    for (let y = y1; y < y2; y += step) {
      const idx = (y * info.width + xx) * 4;
      if (isLikelyMarkPixel(pixels[idx] ?? 0, pixels[idx + 1] ?? 0, pixels[idx + 2] ?? 0)) {
        cur += step;
        if (cur > best) best = cur;
      } else cur = 0;
    }
    return best;
  };

  const runRowThreshold = Math.max(60, Math.round(w * (conservative ? 0.28 : 0.22)));
  const runColThreshold = Math.max(60, Math.round(h * (conservative ? 0.28 : 0.22)));
  const midTop = y1 + Math.floor(b / 2);
  const midBottom = y2 - 1 - Math.floor(b / 2);
  const midLeft = x1 + Math.floor(b / 2);
  const midRight = x2 - 1 - Math.floor(b / 2);
  const edgeSearchY = Math.max(40, Math.min(280, Math.round(h * 0.45)));
  const edgeSearchX = Math.max(40, Math.min(420, Math.round(w * 0.45)));

  const findBestRowNear = (s: number, e: number) => {
    let bestY = -1;
    let bestRun = 0;
    const step = 2;
    const start = Math.min(s, e);
    const end = Math.max(s, e);
    for (let yy = Math.max(y1, start); yy <= Math.min(y2 - 1, end); yy += step) {
      const run = maxRunInRow(yy, step);
      if (run > bestRun) {
        bestRun = run;
        bestY = yy;
      }
    }
    return { y: bestY, run: bestRun };
  };

  const findBestColNear = (s: number, e: number) => {
    let bestX = -1;
    let bestRun = 0;
    const step = 2;
    const start = Math.min(s, e);
    const end = Math.max(s, e);
    for (let xx = Math.max(x1, start); xx <= Math.min(x2 - 1, end); xx += step) {
      const run = maxRunInCol(xx, step);
      if (run > bestRun) {
        bestRun = run;
        bestX = xx;
      }
    }
    return { x: bestX, run: bestRun };
  };

  const topScan = findBestRowNear(y1, y1 + edgeSearchY);
  const bottomScan = findBestRowNear(y2 - edgeSearchY, y2 - 1);
  const leftScan = findBestColNear(x1, x1 + edgeSearchX);
  const rightScan = findBestColNear(x2 - edgeSearchX, x2 - 1);

  const lineTopY = topScan.run >= runRowThreshold ? topScan.y : midTop;
  const lineBottomY = bottomScan.run >= runRowThreshold ? bottomScan.y : midBottom;
  const lineLeftX = leftScan.run >= runColThreshold ? leftScan.x : midLeft;
  const lineRightX = rightScan.run >= runColThreshold ? rightScan.x : midRight;

  const getPerpSamples = (
    x: number,
    y: number,
    dir: "horizontal" | "vertical",
    baseOffset: number,
  ) => {
    for (let extra = 0; extra <= 12; extra += 2) {
      const offset = baseOffset + extra;
      const samples: Array<[number, number, number]> = [];
      if (dir === "horizontal") {
        for (const yy of [y - offset, y + offset])
          if (yy >= 0 && yy < height) {
            const idx = (yy * info.width + x) * 4;
            samples.push([pixels[idx] ?? 0, pixels[idx + 1] ?? 0, pixels[idx + 2] ?? 0]);
          }
      } else {
        for (const xx of [x - offset, x + offset])
          if (xx >= 0 && xx < width) {
            const idx = (y * info.width + xx) * 4;
            samples.push([pixels[idx] ?? 0, pixels[idx + 1] ?? 0, pixels[idx + 2] ?? 0]);
          }
      }
      if (samples.length >= 1) {
        const avg: [number, number, number] = [
          Math.round(samples.reduce((s, v) => s + v[0], 0) / samples.length),
          Math.round(samples.reduce((s, v) => s + v[1], 0) / samples.length),
          Math.round(samples.reduce((s, v) => s + v[2], 0) / samples.length),
        ];
        const [s0, s1] = samples;
        const sideDiff =
          s0 && s1
            ? Math.abs(s0[0] - s1[0]) + Math.abs(s0[1] - s1[1]) + Math.abs(s0[2] - s1[2])
            : 99999;
        return { avg, sideDiff, sampleCount: samples.length };
      }
    }
    return { avg: getNeighborAverage(pixels, width, height, x, y), sideDiff: 9999, sampleCount: 0 };
  };

  const hitTop = topScan.run >= runRowThreshold || maxRunInRow(midTop) >= runRowThreshold;
  const hitBottom = bottomScan.run >= runRowThreshold || maxRunInRow(midBottom) >= runRowThreshold;
  const hitLeft = leftScan.run >= runColThreshold || maxRunInCol(midLeft) >= runColThreshold;
  const hitRight = rightScan.run >= runColThreshold || maxRunInCol(midRight) >= runColThreshold;
  const forcePaint =
    !!options?.force ||
    (hitTop ? 1 : 0) + (hitBottom ? 1 : 0) + (hitLeft ? 1 : 0) + (hitRight ? 1 : 0) >=
      (conservative ? 3 : 2);

  const computeReplacement = (x: number, y: number, mode: "horizontal" | "vertical" | "corner") => {
    const idx = (y * info.width + x) * 4;
    const r = pixels[idx] ?? 0;
    const g = pixels[idx + 1] ?? 0;
    const bb = pixels[idx + 2] ?? 0;
    const baseOffset = b + 3;
    const perp =
      mode === "horizontal"
        ? getPerpSamples(x, y, "horizontal", baseOffset)
        : mode === "vertical"
          ? getPerpSamples(x, y, "vertical", baseOffset)
          : {
              avg: getNeighborAverage(pixels, width, height, x, y),
              sideDiff: 9999,
              sampleCount: 0,
            };
    const relaxed =
      mode === "horizontal"
        ? getDirectionalAverage(pixels, width, height, x, y, true)
        : mode === "vertical"
          ? getDirectionalAverage(pixels, width, height, x, y, false)
          : getNeighborAverage(pixels, width, height, x, y);
    const [nr, ng, nb] = forcePaint ? perp.avg : relaxed || [0, 0, 0];
    const diff = Math.abs(r - nr) + Math.abs(g - ng) + Math.abs(bb - nb);
    const isMark = isMarkerColor(r, g, bb);
    let shouldReplace = false;
    if (isMark) shouldReplace = true;
    else if (forcePaint) {
      const sideSimilar = perp.sampleCount >= 2 && perp.sideDiff <= (conservative ? 110 : 140);
      shouldReplace = sideSimilar && diff >= (conservative ? 90 : 72);
    } else shouldReplace = diff >= outlierDiffThreshold;
    return { shouldReplace, nr, ng, nb };
  };

  const paintBand = (cy: number, isHoriz: boolean) => {
    const half = Math.max(2, Math.min(12, b));
    const from = isHoriz ? Math.max(y1, cy - half) : Math.max(x1, cy - half);
    const to = isHoriz ? Math.min(y2 - 1, cy + half) : Math.min(x2 - 1, cy + half);
    const minRun = Math.max(8, Math.min(120, Math.round((isHoriz ? w : h) * 0.06)));
    for (let c = from; c <= to; c++) {
      let run: Array<{ pos: number; nr: number; ng: number; nb: number }> = [];
      const flush = () => {
        if (run.length >= minRun) {
          for (const it of run) {
            const idx = (isHoriz ? c * info.width + it.pos : it.pos * info.width + c) * 4;
            pixels[idx] = it.nr;
            pixels[idx + 1] = it.ng;
            pixels[idx + 2] = it.nb;
            changed[isHoriz ? c * width + it.pos : it.pos * width + c] = 1;
          }
        }
        run = [];
      };
      const len = isHoriz ? w : h;
      for (let i = 0; i < len; i++) {
        const x = isHoriz ? x1 + i : c;
        const y = isHoriz ? c : y1 + i;
        const isCorner = isHoriz
          ? x < x1 + half || x >= x2 - half
          : y < y1 + half || y >= y2 - half;
        const mode = isCorner ? "corner" : isHoriz ? "horizontal" : "vertical";
        const res = computeReplacement(x, y, mode);
        if (res.shouldReplace)
          run.push({ pos: isHoriz ? x : y, nr: res.nr, ng: res.ng, nb: res.nb });
        else flush();
      }
      flush();
    }
  };

  paintBand(lineTopY, true);
  paintBand(lineBottomY, true);
  paintBand(lineLeftX, false);
  paintBand(lineRightX, false);
}

/**
 * AI 框内的强色区域修复
 */
export function inpaintStrongColorInsideBoxes(
  ctx: CleanerContext,
  candidateBoxes: BoundingBox[],
): number {
  if (candidateBoxes.length === 0) return 0;
  const { width, height } = ctx;
  const mask = new Uint8Array(width * height);
  const isStrongMarkColorLocal = (r: number, g: number, b: number) => {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const mid = r + g + b - max - min;
    return max >= 155 && max - mid >= 90;
  };

  for (const b of candidateBoxes) {
    const rect = toPixelRect(b, width, height, 8);
    for (let y = rect.y1; y < rect.y2; y++) {
      for (let x = rect.x1; x < rect.x2; x++) {
        const idx = (y * width + x) * 4;
        if (
          isStrongMarkColorForInpaint(
            ctx.pixels[idx] ?? 0,
            ctx.pixels[idx + 1] ?? 0,
            ctx.pixels[idx + 2] ?? 0,
          )
        )
          mask[y * width + x] = 1;
      }
    }
  }
  return inpaintMask(ctx, mask);
}

/**
 * 识别并修复 AI 框内的强色垂直长条 (覆盖模式)
 */
export function inpaintStrongColorColumnsInsideBoxes(
  ctx: CleanerContext,
  candidateBoxes: BoundingBox[],
): number {
  if (candidateBoxes.length === 0) return 0;
  const { pixels, width, height, info } = ctx;
  const pad = Math.max(10, Math.round(Math.min(width, height) * 0.008));
  const mask = new Uint8Array(width * height);

  for (const b of candidateBoxes) {
    const rect = toPixelRect(b, width, height, pad);
    if (rect.x2 <= rect.x1 || rect.y2 <= rect.y1) continue;
    if (((rect.x2 - rect.x1) * (rect.y2 - rect.y1)) / (width * height) > 0.08) continue;

    const rectW = rect.x2 - rect.x1;
    const rectH = rect.y2 - rect.y1;
    const edgeBand = Math.max(6, Math.min(18, Math.round(Math.min(rectW, rectH) * 0.06)));
    const runThreshold = Math.max(28, Math.round(rectH * 0.28));
    const countThreshold = Math.max(36, Math.round(rectH * 0.22));

    const testColumn = (x: number) => {
      let count = 0;
      let run = 0;
      let bestRun = 0;
      for (let y = rect.y1; y < rect.y2; y++) {
        const idx = (y * info.width + x) * 4;
        if (isOverlayLikeStrong(pixels[idx] ?? 0, pixels[idx + 1] ?? 0, pixels[idx + 2] ?? 0)) {
          count++;
          run++;
          if (run > bestRun) bestRun = run;
        } else run = 0;
      }
      if (bestRun >= runThreshold && count >= countThreshold) {
        for (let y = rect.y1; y < rect.y2; y++) {
          const idx = (y * info.width + x) * 4;
          if (isOverlayLikeStrong(pixels[idx] ?? 0, pixels[idx + 1] ?? 0, pixels[idx + 2] ?? 0)) {
            for (let dy = -1; dy <= 1; dy++) {
              const ny = y + dy;
              if (ny >= rect.y1 && ny < rect.y2) {
                for (let dx = -1; dx <= 1; dx++) {
                  const nx = x + dx;
                  if (nx >= rect.x1 && nx < rect.x2) mask[ny * width + nx] = 1;
                }
              }
            }
          }
        }
      }
    };
    for (let x = rect.x1; x < Math.min(rect.x2, rect.x1 + edgeBand); x++) testColumn(x);
    for (let x = Math.max(rect.x1, rect.x2 - edgeBand); x < rect.x2; x++) testColumn(x);
  }
  return inpaintMask(ctx, mask);
}

import { DependencyManager } from "../../deps-manager";
import type { BoundingBox, CleanerResult } from "../../types";
import { CLEANER_THRESHOLDS } from "../constants";
import { detectOverlayLineBoxes, detectRectangleLineBoxes } from "../detectors/box";
import {
  detectCornerConnectedLineMask,
  detectEdgeMaskInBoxes,
  detectStrokeMask,
} from "../detectors/mask";
import { estimateTextureComplexity, mergeBoxes, toPixelRect } from "../utils/image";
import type { PixelRect } from "../rect";
import type { DetectionTrace } from "../trace";
import type { CleanerContext } from "./context";
import { inpaintMask, smoothChangedPixels } from "./inpaint";
import { isMarkerColor } from "../utils/color";
import {
  inpaintStrongColorColumnsInsideBoxes,
  inpaintStrongColorInsideBoxes,
  paintRectFrame,
  scoreFrameMarkerPixels,
} from "./painter";

/**
 * Detection 模式核心调度引擎
 */
export async function cleanMarkersLocal(
  imageBuffer: Buffer,
  boxes: BoundingBox[],
): Promise<CleanerResult> {
  const startTime = Date.now();
  let sharp: CleanerContext["sharp"];
  try {
    const sharpModule = await DependencyManager.getInstance().loadSharp();
    sharp = (sharpModule.default || sharpModule) as unknown as CleanerContext["sharp"];
  } catch {
    throw new Error("Sharp module not found.");
  }

  const image = sharp(imageBuffer);
  const metadata = await image.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width === 0 || height === 0) throw new Error("无法读取图片尺寸");

  const { data, info } = await image.raw().ensureAlpha().toBuffer({ resolveWithObject: true });
  const pixels = new Uint8Array(data);
  const changed = new Uint8Array(width * height);
  const textureScore = estimateTextureComplexity(pixels, width, height);
  const isComplexScene = textureScore > CLEANER_THRESHOLDS.TEXTURE_COMPLEXITY;

  const ctx: CleanerContext = {
    pixels,
    changed,
    width,
    height,
    info: { width: info.width, height: info.height },
    isComplexScene,
    sharp,
  };
  let fallbackPixelsSum = 0;

  // 1. 本地检测与合并
  let localBoxes: BoundingBox[] = [];
  let mergedBoxesArr = boxes;
  try {
    const b1 = await detectRectangleLineBoxes(ctx);
    const b2 = await detectOverlayLineBoxes(ctx);
    localBoxes = [...b1, ...b2];
    if (localBoxes.length > 0) mergedBoxesArr = mergeBoxes(boxes, localBoxes);
  } catch {}

  if (mergedBoxesArr.length === 0) {
    return {
      outputBuffer: imageBuffer,
      stats: {
        changedPixels: 0,
        fallbackPixels: 0,
        totalPixels: width * height,
        durationMs: Date.now() - startTime,
      },
    };
  }

  // 2. 本地优先修复
  if (localBoxes.length > 0) {
    fallbackPixelsSum += inpaintStrongColorInsideBoxes(ctx, localBoxes);
    fallbackPixelsSum += inpaintStrongColorColumnsInsideBoxes(ctx, localBoxes);
    const edgeMask = detectEdgeMaskInBoxes(ctx, localBoxes, 10, 420);
    fallbackPixelsSum += inpaintMask(ctx, edgeMask);
  }

  // 3. 边框带涂抹
  const usedRects: Array<{ rect: PixelRect; band: number }> = [];
  const skippedRects: PixelRect[] = [];
  for (const box of mergedBoxesArr) {
    const padding = Math.max(6, Math.min(18, Math.round(Math.min(width, height) * 0.006)));
    let rect = toPixelRect(box, width, height, padding);
    const bandBase = Math.max(
      4,
      Math.min(22, Math.round(Math.min(rect.x2 - rect.x1, rect.y2 - rect.y1) * 0.08)),
    );

    const swappedRect = toPixelRect(
      { ymin: box.xmin, xmin: box.ymin, ymax: box.xmax, xmax: box.ymax },
      width,
      height,
      padding,
    );
    const s1 = scoreFrameMarkerPixels(ctx, rect, bandBase, 4);
    const s2 = scoreFrameMarkerPixels(ctx, swappedRect, bandBase, 4);
    if (s2 >= 12 && s2 > s1 * 2) rect = swappedRect;

    const areaRatio = ((rect.x2 - rect.x1) * (rect.y2 - rect.y1)) / (width * height);
    const isHuge = areaRatio > CLEANER_THRESHOLDS.HUGE_BOX_AREA_RATIO;
    const band = isHuge ? Math.min(bandBase, 12) : bandBase;
    const hugeScoreThreshold = isComplexScene
      ? CLEANER_THRESHOLDS.HUGE_BOX_MIN_SCORE_COMPLEX
      : CLEANER_THRESHOLDS.HUGE_BOX_MIN_SCORE_SIMPLE;

    let forceFromLocal = false;
    for (const lb of localBoxes) {
      const lr = toPixelRect(lb, width, height, 0);
      const inter =
        Math.max(0, Math.min(rect.x2, lr.x2) - Math.max(rect.x1, lr.x1)) *
        Math.max(0, Math.min(rect.y2, lr.y2) - Math.max(rect.y1, lr.y1));
      const union =
        (rect.x2 - rect.x1) * (rect.y2 - rect.y1) + (lr.x2 - lr.x1) * (lr.y2 - lr.y1) - inter;
      if (union > 0 && inter / union > 0.55) {
        forceFromLocal = true;
        break;
      }
    }

    if (
      isHuge &&
      !forceFromLocal &&
      scoreFrameMarkerPixels(ctx, rect, band, 4) < hugeScoreThreshold
    ) {
      skippedRects.push(rect);
      continue;
    }
    paintRectFrame(ctx, rect, band, {
      force: forceFromLocal,
      conservative: isHuge && !forceFromLocal,
    });
    usedRects.push({ rect, band });
  }

  const manualEdgeRects: PixelRect[] = [];
  const manualSpan = Math.max(16, Math.min(Math.round(Math.min(width, height) * 0.05), Math.floor(Math.min(width, height) / 2)));
  manualEdgeRects.push(
    { x1: 0, y1: 0, x2: width, y2: manualSpan },
    { x1: 0, y1: height - manualSpan, x2: width, y2: height },
    { x1: 0, y1: 0, x2: manualSpan, y2: height },
    { x1: width - manualSpan, y1: 0, x2: width, y2: height },
  );
  for (const rect of manualEdgeRects) {
    const band = Math.max(4, Math.min(12, Math.round(Math.min(rect.x2 - rect.x1, rect.y2 - rect.y1) * 0.08)));
    paintRectFrame(ctx, rect, band, { force: true, conservative: false });
    usedRects.push({ rect, band });
  }

  // 4. 兜底 ROI 修复
  const roiRects: PixelRect[] = [];
  // 调优: 将 skippedHugeBox 也纳入 ROI 检测范围，让 mask 检测做最后一道防线
  const edgeBand = Math.max(14, Math.min(48, Math.round(Math.min(width, height) * 0.03)));
  const maskSourceRects = [...usedRects.map((it) => it.rect), ...skippedRects];
  const maxMaskSources = 32;

  for (const rect of maskSourceRects.slice(0, maxMaskSources)) {
    const pad = Math.max(10, Math.min(34, Math.min(rect.x2 - rect.x1, rect.y2 - rect.y1) + 10));
    const { x1, y1, x2, y2 } = rect;
    if (y1 + pad < y2) roiRects.push({ x1, y1, x2, y2: y1 + pad });
    if (y2 - pad > y1) roiRects.push({ x1, y1: y2 - pad, x2, y2 });
    if (x1 + pad < x2) roiRects.push({ x1, y1, x2: x1 + pad, y2 });
    if (x2 - pad > x1) roiRects.push({ x1: x2 - pad, y1, x2, y2 });
    const minDim = Math.min(rect.x2 - rect.x1, rect.y2 - rect.y1);
    const centerPad = Math.max(6, Math.min(30, Math.round(minDim * 0.35)));
    const centerRect = {
      x1: rect.x1 + centerPad,
      y1: rect.y1 + centerPad,
      x2: rect.x2 - centerPad,
      y2: rect.y2 - centerPad,
    };
    if (centerRect.x2 > centerRect.x1 + 3 && centerRect.y2 > centerRect.y1 + 3) {
      roiRects.push(centerRect);
    }
  }

  // 扩展边缘区域，防止顶/底/左/右残留
  roiRects.push({ x1: 0, y1: 0, x2: width, y2: edgeBand });
  roiRects.push({ x1: 0, y1: height - edgeBand, x2: width, y2: height });
  roiRects.push({ x1: 0, y1: 0, x2: edgeBand, y2: height });
  roiRects.push({ x1: width - edgeBand, y1: 0, x2: width, y2: height });
  const edgeMask = new Uint8Array(width * height);
  const markIfEdge = (x: number, y: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const idx = (y * width + x) * 4;
    if (isMarkerColor(pixels[idx] ?? 0, pixels[idx + 1] ?? 0, pixels[idx + 2] ?? 0)) {
      edgeMask[y * width + x] = 1;
    }
  };
  for (let y = 0; y < edgeBand; y++) {
    for (let x = 0; x < width; x++) markIfEdge(x, y);
  }
  for (let y = height - edgeBand; y < height; y++) {
    if (y < 0) continue;
    for (let x = 0; x < width; x++) markIfEdge(x, y);
  }
  for (let x = 0; x < edgeBand; x++) {
    for (let y = 0; y < height; y++) markIfEdge(x, y);
  }
  for (let x = width - edgeBand; x < width; x++) {
    if (x < 0) continue;
    for (let y = 0; y < height; y++) markIfEdge(x, y);
  }

  if (roiRects.length > 0) {
    try {
      const m1 = await detectCornerConnectedLineMask(ctx, roiRects);
      fallbackPixelsSum += inpaintMask(ctx, m1);
      const m2 = await detectStrokeMask(ctx, roiRects);
      if (m2.some((v) => v === 1)) fallbackPixelsSum += inpaintMask(ctx, m2);
    } catch {}
  }

  // 针对边缘残留再跑一次边缘检测
  const edgeBoxes: BoundingBox[] = [];
  if (edgeBand > 1) {
    edgeBoxes.push(
      { ymin: 0, xmin: 0, ymax: edgeBand / height, xmax: 1 },
      { ymin: (height - edgeBand) / height, xmin: 0, ymax: 1, xmax: 1 },
      { ymin: 0, xmin: 0, ymax: 1, xmax: edgeBand / width },
      { ymin: 0, xmin: (width - edgeBand) / width, ymax: 1, xmax: 1 },
    );
    try {
      const edgeOnlyMask = detectEdgeMaskInBoxes(ctx, edgeBoxes, 6, 260);
      if (edgeOnlyMask.some((v) => v === 1)) fallbackPixelsSum += inpaintMask(ctx, edgeOnlyMask);
    } catch {}
  }

  if (edgeMask.some((v) => v === 1)) fallbackPixelsSum += inpaintMask(ctx, edgeMask);

  const edgeLineMask = new Uint8Array(width * height);
  const markMask = (x: number, y: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    edgeLineMask[y * width + x] = 1;
  };
  const minRun = 4;
  const scanHorizontal = (yStart: number, yEnd: number) => {
    for (let y = yStart; y < yEnd && y < height; y++) {
      let run = 0;
      let start = 0;
      for (let x = 0; x <= width; x++) {
        const isOn = x < width && isMarkerColor(pixels[(y * width + x) * 4] ?? 0, pixels[(y * width + x) * 4 + 1] ?? 0, pixels[(y * width + x) * 4 + 2] ?? 0);
        if (isOn) {
          if (run === 0) start = x;
          run++;
        }
        if (!isOn || x === width) {
          if (run >= minRun) {
            for (let xx = start; xx < x; xx++) markMask(xx, y);
          }
          run = 0;
        }
      }
    }
  };
  const scanVertical = (xStart: number, xEnd: number) => {
    for (let x = xStart; x < xEnd && x < width; x++) {
      let run = 0;
      let start = 0;
      for (let y = 0; y <= height; y++) {
        const isOn = y < height && isMarkerColor(pixels[(y * width + x) * 4] ?? 0, pixels[(y * width + x) * 4 + 1] ?? 0, pixels[(y * width + x) * 4 + 2] ?? 0);
        if (isOn) {
          if (run === 0) start = y;
          run++;
        }
        if (!isOn || y === height) {
          if (run >= minRun) {
            for (let yy = start; yy < y; yy++) markMask(x, yy);
          }
          run = 0;
        }
      }
    }
  };

  scanHorizontal(0, edgeBand);
  scanHorizontal(Math.max(0, height - edgeBand), height);
  scanVertical(0, edgeBand);
  scanVertical(Math.max(0, width - edgeBand), width);

  if (edgeLineMask.some((v) => v === 1)) fallbackPixelsSum += inpaintMask(ctx, edgeLineMask);

  const countRowMarkers = (y: number) => {
    if (y < 0 || y >= height) return width;
    let cnt = 0;
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (isMarkerColor(pixels[idx] ?? 0, pixels[idx + 1] ?? 0, pixels[idx + 2] ?? 0)) cnt++;
      if (cnt > width * 0.02) break;
    }
    return cnt;
  };

  const findCleanRow = (startY: number, dir: 1 | -1) => {
    let y = startY;
    while (y >= 0 && y < height) {
      if (countRowMarkers(y) <= Math.max(1, Math.round(width * 0.01))) return y;
      y += dir;
    }
    return Math.max(0, Math.min(height - 1, startY));
  };

  const countColMarkers = (x: number) => {
    if (x < 0 || x >= width) return height;
    let cnt = 0;
    for (let y = 0; y < height; y++) {
      const idx = (y * width + x) * 4;
      if (isMarkerColor(pixels[idx] ?? 0, pixels[idx + 1] ?? 0, pixels[idx + 2] ?? 0)) cnt++;
      if (cnt > height * 0.02) break;
    }
    return cnt;
  };

  const findCleanCol = (startX: number, dir: 1 | -1) => {
    let x = startX;
    while (x >= 0 && x < width) {
      if (countColMarkers(x) <= Math.max(1, Math.round(height * 0.01))) return x;
      x += dir;
    }
    return Math.max(0, Math.min(width - 1, startX));
  };

  const copyHorizontalEdge = (targetY: number, sampleY: number) => {
    if (targetY < 0 || targetY >= height) return;
    const sy = Math.max(0, Math.min(height - 1, sampleY));
    for (let x = 0; x < width; x++) {
      const idx = (targetY * width + x) * 4;
      if (!isMarkerColor(pixels[idx] ?? 0, pixels[idx + 1] ?? 0, pixels[idx + 2] ?? 0)) continue;
      const sIdx = (sy * width + x) * 4;
      pixels[idx] = pixels[sIdx] ?? 0;
      pixels[idx + 1] = pixels[sIdx + 1] ?? 0;
      pixels[idx + 2] = pixels[sIdx + 2] ?? 0;
      changed[targetY * width + x] = 1;
    }
  };

  const copyVerticalEdge = (targetX: number, sampleX: number) => {
    if (targetX < 0 || targetX >= width) return;
    const sx = Math.max(0, Math.min(width - 1, sampleX));
    for (let y = 0; y < height; y++) {
      const idx = (y * width + targetX) * 4;
      if (!isMarkerColor(pixels[idx] ?? 0, pixels[idx + 1] ?? 0, pixels[idx + 2] ?? 0)) continue;
      const sIdx = (y * width + sx) * 4;
      pixels[idx] = pixels[sIdx] ?? 0;
      pixels[idx + 1] = pixels[sIdx + 1] ?? 0;
      pixels[idx + 2] = pixels[sIdx + 2] ?? 0;
      changed[y * width + targetX] = 1;
    }
  };

  const topSample = findCleanRow(edgeBand + 1, 1);
  for (let y = 0; y < edgeBand && y < height; y++) copyHorizontalEdge(y, topSample);
  const bottomSample = findCleanRow(height - edgeBand - 2, -1);
  for (let y = Math.max(0, height - edgeBand); y < height; y++) copyHorizontalEdge(y, bottomSample);
  const leftSample = findCleanCol(edgeBand + 1, 1);
  for (let x = 0; x < edgeBand && x < width; x++) copyVerticalEdge(x, leftSample);
  const rightSample = findCleanCol(width - edgeBand - 2, -1);
  for (let x = Math.max(0, width - edgeBand); x < width; x++) copyVerticalEdge(x, rightSample);

  smoothChangedPixels(ctx);

  let changedPixels = 0;
  for (let i = 0; i < changed.length; i++) if (changed[i] === 1) changedPixels++;
  const stats = {
    changedPixels,
    fallbackPixels: fallbackPixelsSum,
    totalPixels: width * height,
    durationMs: Date.now() - startTime,
  };

  const trace: DetectionTrace = {
    usedRects: usedRects.map((it) => it.rect),
    skippedRects,
    roiRects,
    textureScore,
    isComplexScene,
    width,
    height,
  };

  const out = sharp(pixels, {
    raw: { width: info.width, height: info.height, channels: 4 },
  }).withMetadata();
  const fmt = metadata.format?.toLowerCase();
  let outputBuffer: Buffer;
  if (fmt === "jpeg" || fmt === "jpg") {
    outputBuffer = await out
      .jpeg({ quality: 98, chromaSubsampling: "4:4:4", progressive: false, mozjpeg: true })
      .toBuffer();
  } else if (fmt === "webp") {
    outputBuffer = await out.webp({ quality: 95, effort: 6 }).toBuffer();
  } else {
    outputBuffer = await out.png().toBuffer();
  }

  return { outputBuffer, stats, trace };
}

import { DependencyManager } from "../../deps-manager";
import type { BoundingBox, CleanerResult } from "../../types";
import { CLEANER_THRESHOLDS } from "../constants";
import { estimateTextureComplexity, mergeBoxes, toPixelRect } from "../utils/image";
import { detectRectangleLineBoxes, detectOverlayLineBoxes } from "../detectors/box";
import { detectCornerConnectedLineMask, detectStrokeMask, detectEdgeMaskInBoxes } from "../detectors/mask";
import { inpaintMask, smoothChangedPixels } from "./inpaint";
import { scoreFrameMarkerPixels, paintRectFrame, inpaintStrongColorInsideBoxes, inpaintStrongColorColumnsInsideBoxes } from "./painter";
import type { CleanerContext } from "./context";

/**
 * Detection 模式核心调度引擎
 */
export async function cleanMarkersLocal(
  imageBuffer: Buffer,
  boxes: BoundingBox[],
): Promise<CleanerResult> {
  const startTime = Date.now();
  let sharp: any;
  try {
    const sharpModule = await DependencyManager.getInstance().loadSharp();
    sharp = sharpModule.default || sharpModule;
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

  const ctx: CleanerContext = { pixels, changed, width, height, info: { width: info.width, height: info.height }, isComplexScene, sharp };
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
    return { outputBuffer: imageBuffer, stats: { changedPixels: 0, fallbackPixels: 0, totalPixels: width * height, durationMs: Date.now() - startTime } };
  }

  // 2. 本地优先修复
  if (localBoxes.length > 0) {
    fallbackPixelsSum += inpaintStrongColorInsideBoxes(ctx, localBoxes);
    fallbackPixelsSum += inpaintStrongColorColumnsInsideBoxes(ctx, localBoxes);
    const edgeMask = detectEdgeMaskInBoxes(ctx, localBoxes, 10, 420);
    fallbackPixelsSum += inpaintMask(ctx, edgeMask);
  }

  // 3. 边框带涂抹
  const usedRects: Array<{ rect: any; band: number }> = [];
  for (const box of mergedBoxesArr) {
    const padding = Math.max(6, Math.min(18, Math.round(Math.min(width, height) * 0.006)));
    let rect = toPixelRect(box, width, height, padding);
    const bandBase = Math.max(4, Math.min(22, Math.round(Math.min(rect.x2 - rect.x1, rect.y2 - rect.y1) * 0.08)));

    const swappedRect = toPixelRect({ ymin: box.xmin, xmin: box.ymin, ymax: box.xmax, xmax: box.ymax }, width, height, padding);
    const s1 = scoreFrameMarkerPixels(ctx, rect, bandBase, 4), s2 = scoreFrameMarkerPixels(ctx, swappedRect, bandBase, 4);
    if (s2 >= 12 && s2 > s1 * 2) rect = swappedRect;

    const areaRatio = ((rect.x2 - rect.x1) * (rect.y2 - rect.y1)) / (width * height);
    const isHuge = areaRatio > CLEANER_THRESHOLDS.HUGE_BOX_AREA_RATIO;
    const band = isHuge ? Math.min(bandBase, 12) : bandBase;

    let forceFromLocal = false;
    for (const lb of localBoxes) {
      const lr = toPixelRect(lb, width, height, 0);
      const inter = Math.max(0, Math.min(rect.x2, lr.x2) - Math.max(rect.x1, lr.x1)) * Math.max(0, Math.min(rect.y2, lr.y2) - Math.max(rect.y1, lr.y1));
      const union = (rect.x2-rect.x1)*(rect.y2-rect.y1) + (lr.x2-lr.x1)*(lr.y2-lr.y1) - inter;
      if (union > 0 && inter / union > 0.55) { forceFromLocal = true; break; }
    }

    if (isHuge && !forceFromLocal && scoreFrameMarkerPixels(ctx, rect, band, 4) < (isComplexScene ? 32 : 24)) continue;
    paintRectFrame(ctx, rect, band, { force: forceFromLocal, conservative: isHuge && !forceFromLocal });
    usedRects.push({ rect, band });
  }

  // 4. 兜底 ROI 修复
  const roiRects: any[] = [];
  for (const it of usedRects.slice(0, 24)) {
    const r = it.rect, pad = Math.max(10, Math.min(34, it.band + 10));
    const { x1, y1, x2, y2 } = r;
    if (y1 + pad < y2) roiRects.push({ x1, y1, x2, y2: y1 + pad });
    if (y2 - pad > y1) roiRects.push({ x1, y1: y2 - pad, x2, y2 });
    if (x1 + pad < x2) roiRects.push({ x1, y1, x2: x1 + pad, y2 });
    if (x2 - pad > x1) roiRects.push({ x1: x2 - pad, y1, x2, y2 });
  }

  if (roiRects.length > 0) {
    try {
      const m1 = await detectCornerConnectedLineMask(ctx, roiRects);
      fallbackPixelsSum += inpaintMask(ctx, m1);
      const m2 = await detectStrokeMask(ctx, roiRects);
      if (m2.some(v => v === 1)) fallbackPixelsSum += inpaintMask(ctx, m2);
    } catch {}
  }

  smoothChangedPixels(ctx);

  let changedPixels = 0;
  for (let i = 0; i < changed.length; i++) if (changed[i] === 1) changedPixels++;
  const stats = { changedPixels, fallbackPixels: fallbackPixelsSum, totalPixels: width * height, durationMs: Date.now() - startTime };

  const out = sharp(pixels, { raw: { width: info.width, height: info.height, channels: 4 } }).withMetadata();
  const fmt = metadata.format?.toLowerCase();
  let outputBuffer: Buffer;
  if (fmt === "jpeg" || fmt === "jpg") {
    outputBuffer = await out.jpeg({ quality: 98, chromaSubsampling: "4:4:4", progressive: false, mozjpeg: true }).toBuffer();
  } else if (fmt === "webp") {
    outputBuffer = await out.webp({ quality: 95, effort: 6 }).toBuffer();
  } else {
    outputBuffer = await out.png().toBuffer();
  }

  return { outputBuffer, stats };
}

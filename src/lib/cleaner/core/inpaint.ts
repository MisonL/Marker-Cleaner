import { CLEANER_THRESHOLDS } from "../constants";
import { isLikelyMarkPixel } from "../utils/color";
import type { CleanerContext } from "./context";

/**
 * 在 Context 上执行插值修复
 */
/**
 * Simple mask dilation to ensure we aren't sampling from "dirty" edges.
 */
function dilateMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const result = new Uint8Array(mask);
  for (let r = 0; r < radius; r++) {
    const temp = new Uint8Array(result);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const p = y * width + x;
        if (temp[p] === 1) continue;
        if (
          temp[p - 1] === 1 || temp[p + 1] === 1 ||
          temp[p - width] === 1 || temp[p + width] === 1
        ) {
          result[p] = 1;
        }
      }
    }
  }
  return result;
}

/**
 * Texture Synthesis Inpainting (PatchMatch-lite)
 */
export function inpaintMask(ctx: CleanerContext, mask: Uint8Array): number {
  const { pixels, changed, width, height } = ctx;
  
  // 1. Dilate mask slightly to avoid "dirty edges" (residuals)
  const dilated = dilateMask(mask, width, height, 2);
  
  const indices: number[] = [];
  for (let i = 0; i < dilated.length; i++) {
    if (dilated[i] === 1) indices.push(i);
  }
  if (indices.length === 0) return 0;

  let fallbackCount = 0;

  const getPixel = (x: number, y: number) => {
    const idx = (y * width + x) * 4;
    return [pixels[idx] ?? 0, pixels[idx + 1] ?? 0, pixels[idx + 2] ?? 0] as const;
  };

  const PATCH_RADIUS = 2; // 5x5 patch
  const SEARCH_RADIUS = 40; // Balanced search radius for quality/speed
  const SEARCH_STEP = 2;  // Finer search
  
  // Use a snapshot for sampling to keep sources consistent
  const sourcePixels = pixels.slice();
  const getSourcePixel = (x: number, y: number) => {
    const idx = (y * width + x) * 4;
    return [sourcePixels[idx] ?? 0, sourcePixels[idx + 1] ?? 0, sourcePixels[idx + 2] ?? 0] as const;
  };

  // Onion peeling: fills from edges in
  for (let pass = 0; pass < 10; pass++) {
    let progressed = 0;
    
    for (const p of indices) {
      if (dilated[p] === 0) continue; 
      
      const x = p % width;
      const y = Math.floor(p / width);

      // Require at least some context
      let knownPixels = 0;
      for (let dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          if (dilated[ny * width + nx] === 0) knownPixels++;
        }
      }

      if (knownPixels < 4) continue;

      let bestScore = Infinity;
      let bestR = 0, bestG = 0, bestB = 0;
      let found = false;

      // Spiral search or random search would be better, but box is simple.
      const yStart = Math.max(0, y - SEARCH_RADIUS);
      const yEnd = Math.min(height - 1, y + SEARCH_RADIUS);
      const xStart = Math.max(0, x - SEARCH_RADIUS);
      const xEnd = Math.min(width - 1, x + SEARCH_RADIUS);

      for (let sy = yStart; sy <= yEnd; sy += SEARCH_STEP) {
        for (let sx = xStart; sx <= xEnd; sx += SEARCH_STEP) {
           const sIdx = sy * width + sx;
           if (dilated[sIdx] === 1) continue; 
           
           const [sr, sg, sb] = getSourcePixel(sx, sy);
           if (isLikelyMarkPixel(sr, sg, sb)) continue;

           let currentScore = 0;
           let validComparisons = 0;

           for (let py = -PATCH_RADIUS; py <= PATCH_RADIUS; py++) {
             const ty = y + py, csy = sy + py;
             if (ty < 0 || ty >= height || csy < 0 || csy >= height) continue;
             
             for (let px = -PATCH_RADIUS; px <= PATCH_RADIUS; px++) {
                const tx = x + px, csx = sx + px;
                if (tx < 0 || tx >= width || csx < 0 || csx >= width) continue;

                if (dilated[ty * width + tx] === 0) {
                   const [tr, tg, tb] = getPixel(tx, ty);
                   const [cr, cg, cb] = getSourcePixel(csx, csy);
                   
                   if (mask[csy * width + csx] === 1 || isLikelyMarkPixel(cr, cg, cb)) {
                      currentScore += 10000;
                   } else {
                      const dr = tr - cr, dg = tg - cg, db = tb - cb;
                      currentScore += dr * dr + dg * dg + db * db;
                   }
                   validComparisons++;
                   if (currentScore >= bestScore) break;
                }
             }
             if (currentScore >= bestScore) break;
           }

           // Bias for closer pixels
           const distSq = (sx - x) * (sx - x) + (sy - y) * (sy - y);
           currentScore += distSq * 0.02;

           if (validComparisons > 0 && currentScore < bestScore) {
              bestScore = currentScore;
              bestR = sr;
              bestG = sg;
              bestB = sb;
              found = true;
              if (bestScore < 20) break;
           }
        }
        if (found && bestScore < 20) break; 
      }

      if (found) {
        const idx = (y * width + x) * 4;
        pixels[idx] = bestR;
        pixels[idx + 1] = bestG;
        pixels[idx + 2] = bestB;
        changed[p] = 1;
        dilated[p] = 0;
        progressed++;
      }
    }
    if (progressed === 0) break;
  }

  // Final fallback
  for (const p of indices) {
    if (dilated[p] === 0) continue;
    const x = p % width, y = Math.floor(p / width);
    let sr = 0, sg = 0, sb = 0, count = 0;
    for (let dy = -6; dy <= 6; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -6; dx <= 6; dx++) {
         const nx = x + dx;
         if (nx < 0 || nx >= width) continue;
         if (dilated[ny * width + nx] === 0) {
             const [r, g, b] = getPixel(nx, ny);
             sr += r; sg += g; sb += b;
             count++;
         }
      }
    }
    if (count > 0) {
       const idx = (y * width + x) * 4;
       pixels[idx] = Math.round(sr / count);
       pixels[idx + 1] = Math.round(sg / count);
       pixels[idx + 2] = Math.round(sb / count);
       dilated[p] = 0;
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
  
  // For complex scenes, we avoid smoothing to preserve synthesized textures
  if (isComplexScene) return;

  const total = width * height;
  let changedCount = 0;
  for (let i = 0; i < changed.length; i++) changedCount += changed[i] ? 1 : 0;
  if (changedCount === 0) return;

  const ratio = changedCount / total;
  if (ratio > 0.35) return;

  const iterations = ratio > 0.15 ? 1 : 2;

  for (let iter = 0; iter < iterations; iter++) {
    const src = pixels.slice();
    for (let p = 0; p < changed.length; p++) {
      if (changed[p] === 0) continue;
      const x = p % width, y = Math.floor(p / width);
      let accR = 0, accG = 0, accB = 0, wsum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const np = ny * width + nx;
          const w = np === p ? 1 : changed[np] === 0 ? 3 : 1; // Bias towards original background
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

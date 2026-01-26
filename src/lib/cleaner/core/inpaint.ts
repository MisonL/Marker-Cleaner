import { CLEANER_THRESHOLDS } from "../constants";
import { isLikelyMarkPixel } from "../utils/color";
import type { CleanerContext } from "./context";

/**
 * 在 Context 上执行插值修复
 */
/**
 * Texture Synthesis Inpainting (Simplified PatchMatch)
 * Finds the best matching patch in the neighborhood and copies the center pixel.
 */
export function inpaintMask(ctx: CleanerContext, mask: Uint8Array): number {
  const { pixels, changed, width, height, info } = ctx;
  const indices: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 1) indices.push(i);
  }
  if (indices.length === 0) return 0;

  let fallbackCount = 0;

  const getPixel = (x: number, y: number) => {
    const idx = (y * width + x) * 4;
    return [pixels[idx] ?? 0, pixels[idx + 1] ?? 0, pixels[idx + 2] ?? 0] as const;
  };

  const PATCH_RADIUS = 2; // 5x5 patch
  const SEARCH_RADIUS = 20; // Search up to 20px away
  const SEARCH_STEP = 2; // Optimization: skip every other pixel
  
  // Create a copy of mask to check original state during passes
  const originalMask = new Uint8Array(mask);

  // We do multiple passes to fill from edges inward
  for (let pass = 0; pass < 8; pass++) {
    let progressed = 0;
    
    // Shuffle indices for better randomness in filling? Or just Iterate.
    // Iterating sequentially is fine for onion-peeling effect.
    
    for (const p of indices) {
      if (mask[p] === 0) continue; // Already filled
      
      const x = p % width;
      const y = Math.floor(p / width);

      // check if we have enough neighbors to form a context
      // Count known pixels in 5x5 patch
      let knownPixels = 0;
      for (let dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy++) {
        for (let dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx++) {
          const ny = y + dy;
          const nx = x + dx;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
             if (mask[ny * width + nx] === 0) knownPixels++;
          }
        }
      }

      // If we don't have enough context (e.g. at least 3 pixels), skip for now (wait for neighbors to fill)
      if (knownPixels < 3) continue;

      // Search for best patch
      let bestScore = Infinity;
      let bestR = 0, bestG = 0, bestB = 0;
      let found = false;

      // Spiral search or simple box search
      for (let dy = -SEARCH_RADIUS; dy <= SEARCH_RADIUS; dy += SEARCH_STEP) {
        for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx += SEARCH_STEP) {
           const sy = y + dy;
           const sx = x + dx;
           
           if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue;
           
           // Candidate center must be valid and NOT a red marker pixel
           // Check if candidate PATCh is valid (mostly valid)
           // Optimization: Just check center pixel validity first
           const sIdx = sy * width + sx;
           if (originalMask[sIdx] === 1 || mask[sIdx] === 1) continue; 
           
           const [sr, sg, sb] = getPixel(sx, sy);
           if (isLikelyMarkPixel(sr, sg, sb)) continue;

           // Compute patch difference (SSD)
           let currentScore = 0;
           let validComparisons = 0;

           for (let py = -PATCH_RADIUS; py <= PATCH_RADIUS; py++) {
             for (let px = -PATCH_RADIUS; px <= PATCH_RADIUS; px++) {
                const ty = y + py;
                const tx = x + px;
                const csy = sy + py;
                const csx = sx + px;
                
                if (ty < 0 || ty >= height || tx < 0 || tx >= width) continue;
                if (csy < 0 || csy >= height || csx < 0 || csx >= width) continue;

                // Compare only if target pixel is known
                if (mask[ty * width + tx] === 0) {
                   const [tr, tg, tb] = getPixel(tx, ty);
                   const [cr, cg, cb] = getPixel(csx, csy);
                   
                   // Penalty if source patch contains mask or red pixels
                   // (We already checked center, but checking neighbors prevents bleeding)
                   if (originalMask[csy * width + csx] === 1) {
                      currentScore += 100000; // invalid source patch
                   } else {
                      currentScore += Math.abs(tr - cr) + Math.abs(tg - cg) + Math.abs(tb - cb);
                   }
                   validComparisons++;
                }
             }
           }

           if (validComparisons > 0 && currentScore < bestScore) {
              bestScore = currentScore;
              bestR = sr;
              bestG = sg;
              bestB = sb;
              found = true;
              if (bestScore < 10) break; // Early exit if very good match
           }
        }
        if (found && bestScore < 10) break; 
      }

      if (found) {
        const idx = (y * width + x) * 4;
        pixels[idx] = bestR;
        pixels[idx + 1] = bestG;
        pixels[idx + 2] = bestB;
        changed[p] = 1; // Mark as changed for smoothing later
        mask[p] = 0;    // Mark as filled
        progressed++;
      }
    }
    
    if (progressed === 0) break;
  }

  // Fallback: Simple Average for any remaining holes
  for (const p of indices) {
    if (mask[p] === 0) continue;
    const x = p % width;
    const y = Math.floor(p / width);
    let sr = 0, sg = 0, sb = 0, count = 0;
    
    // Larger radius for fallback
    for (let dy = -5; dy <= 5; dy++) {
      for (let dx = -5; dx <= 5; dx++) {
         const nx = x + dx;
         const ny = y + dy;
         if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
         if (mask[ny * width + nx] === 0) {
             const idx = (ny * width + nx) * 4;
             sr += pixels[idx] ?? 0;
             sg += pixels[idx+1] ?? 0;
             sb += pixels[idx+2] ?? 0;
             count++;
         }
      }
    }

    if (count > 0) {
       const idx = (y * width + x) * 4;
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

      let accR = 0;
      let accG = 0;
      let accB = 0;
      let wsum = 0;
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

/**
 * 检测是否为通用标记颜色 (红/橙/黄/蓝等高饱和度识别色)
 */
export function isMarkerColor(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const saturation = max === 0 ? 0 : delta / max;

  if (saturation < 0.22) return false;
  if (max < 30) return false;

  if (r >= g * 1.03 && r >= b * 1.1) return true;
  if (r > 100 && g > 100 && b < r * 0.8 && Math.abs(r - g) < 80) return true;
  if (b > r * 1.3 && b > g * 1.1) return true;
  if (r > 140 && b > 140 && g < 120) return true;

  return false;
}

/**
 * 宽松的“可能是标记线条像素”判断 (用于采样排除)
 */
export function isLikelyMarkPixel(r: number, g: number, b: number): boolean {
  if (isMarkerColor(r, g, b)) return true;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const saturation = max === 0 ? 0 : delta / max;
  if (max < 80) return false;
  if (saturation < 0.45) return false;

  const mid = r + g + b - max - min;
  const diff = max - mid;
  if (max >= 150 && diff >= 85) return true;
  if (diff < 70) return false;

  if (r > g * 1.18 && r > b * 1.18) return true;
  if (g > r * 1.18 && g > b * 1.18) return true;
  if (b > r * 1.18 && b > g * 1.18) return true;
  if (r > 150 && g > 120 && b < 130 && Math.abs(r - g) < 90) return true;
  return false;
}

/**
 * 用于 detectCornerConnectedLineMask 的强色判定
 */
export function isStrongMarkColorForCorner(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const mid = r + g + b - max - min;
  const diff = max - mid;
  if (max < 155) return false;
  if (diff < 90) return false;
  if (r > 170 && g > 140 && b < 135 && Math.abs(r - g) < 90) return true;
  return true;
}

/**
 * 用于 inpaintStrongColorInsideBoxes 的强色判定
 */
export function isStrongMarkColorForInpaint(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const mid = r + g + b - max - min;
  const diff = max - mid;
  if (max < 160) return false;
  if (diff < 95) return false;
  if (r > g * 1.05 || (r > 160 && g > 160 && b < 140)) return true;
  return false;
}

/**
 * 用于 detectRectangleLineBoxes 的线框颜色判定
 */
export function isLineColor(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const mid = r + g + b - max - min;
  const diff = max - mid;
  if (max < 150) return false;
  if (diff < 80) return false;
  if (r > g * 1.05 || b > r * 1.1) return true;
  return false;
}

/**
 * 用于 detectOverlayLineBoxes 的红色叠加判定
 */
export function isOverlayRed(r: number, g: number, b: number): boolean {
  return r > 160 && g < 140 && b < 140 && r > g * 1.3;
}

/**
 * 用于 inpaintStrongColorColumnsInsideBoxes 的覆盖色判定
 */
export function isOverlayLikeStrong(r: number, g: number, b: number): boolean {
  if (r <= 180) return false;
  return r - g >= 70 && r - b >= 70;
}

/**
 * 针对复杂场景优化的标记笔色相判断
 */
export function isMarkerLike(r: number, g: number, b: number, isComplexScene: boolean): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const saturation = max === 0 ? 0 : delta / max;
  if (max < 100) return false;
  if (saturation < 0.55) return false;

  let hue = 0;
  if (delta !== 0) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
    if (hue < 0) hue += 360;
  }

  const isRed = hue <= 30 || hue >= 330;
  const isOrangeYellow = hue >= 30 && hue <= 90;
  const isBlue = hue >= 190 && hue <= 260;
  const isMagenta = hue >= 285 && hue <= 330;

  return isRed || isOrangeYellow || isMagenta || (!isComplexScene && isBlue);
}

/**
 * 定向取样插值
 */
export function getDirectionalAverage(
  pixels: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  isHoriz: boolean
): [number, number, number] | null {
  const r = 3;
  let sr = 0, sg = 0, sb = 0, sc = 0;

  if (isHoriz) {
    for (let dy = -r; dy <= r; dy++) {
      if (dy === 0) continue;
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      const idx = (ny * width + x) * 4;
      sr += pixels[idx] ?? 0; sg += pixels[idx + 1] ?? 0; sb += pixels[idx + 2] ?? 0; sc++;
    }
  } else {
    for (let dx = -r; dx <= r; dx++) {
      if (dx === 0) continue;
      const nx = x + dx;
      if (nx < 0 || nx >= width) continue;
      const idx = (y * width + nx) * 4;
      sr += pixels[idx] ?? 0; sg += pixels[idx + 1] ?? 0; sb += pixels[idx + 2] ?? 0; sc++;
    }
  }

  if (sc === 0) return null;
  return [Math.round(sr / sc), Math.round(sg / sc), Math.round(sb / sc)];
}

import type { PixelRect } from "./rect";

export interface DetectionTrace {
  usedRects: PixelRect[];
  skippedRects: PixelRect[];
  roiRects: PixelRect[];
  textureScore: number;
  isComplexScene: boolean;
  width: number;
  height: number;
}

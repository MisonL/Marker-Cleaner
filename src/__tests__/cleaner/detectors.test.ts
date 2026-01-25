import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import type { CleanerContext } from "../../lib/cleaner/core/context";
import { detectCornerConnectedLineMask, detectStrokeMask } from "../../lib/cleaner/detectors/mask";

// Create a context with real sharp
const createContext = async (width: number, height: number): Promise<CleanerContext> => {
  const pixels = new Uint8Array(width * height * 4);
  const changed = new Uint8Array(width * height);
  // Default White
  pixels.fill(255);
  // Force full alpha
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;

  return {
    pixels,
    changed,
    width,
    height,
    info: { width, height },
    isComplexScene: false,
    sharp: sharp as any, // Cast to any to match strict type if needed or rely on compatibility
  };
};

const drawLine = (
  pixels: Uint8Array,
  width: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: [number, number, number],
) => {
  // Simple Horizontal or Vertical line
  if (x1 === x2) {
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
      const idx = (y * width + x1) * 4;
      pixels[idx] = color[0];
      pixels[idx + 1] = color[1];
      pixels[idx + 2] = color[2];
    }
  } else if (y1 === y2) {
    for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
      const idx = (y1 * width + x) * 4;
      pixels[idx] = color[0];
      pixels[idx + 1] = color[1];
      pixels[idx + 2] = color[2];
    }
  }
};

describe("Cleaner Detectors", () => {
  describe("detectCornerConnectedLineMask", () => {
    test("should detect connected red lines", async () => {
      const width = 100;
      const height = 100;
      const ctx = await createContext(width, height);

      // Draw a RED L-shape
      // Red: 255, 0, 0
      drawLine(ctx.pixels, width, 20, 20, 20, 80, [255, 0, 0]); // Vertical
      drawLine(ctx.pixels, width, 20, 80, 80, 80, [255, 0, 0]); // Horizontal

      // The detector resizes image, so we expect some mask bits to be set
      const mask = await detectCornerConnectedLineMask(ctx);

      let maskCount = 0;
      for (let i = 0; i < mask.length; i++) if (mask[i]) maskCount++;

      expect(maskCount).toBeGreaterThan(10);

      // Check if corners are detected
      // 20, 80 should be masked
      expect(mask[80 * width + 20]).toBe(1);
    });

    test("should ignore localized noise (not lines)", async () => {
      const width = 100;
      const height = 100;
      const ctx = await createContext(width, height);

      // Draw a small red dot
      const cx = 50;
      const cy = 50;
      const idx = (cy * width + cx) * 4;
      ctx.pixels[idx] = 255;
      ctx.pixels[idx + 1] = 0;
      ctx.pixels[idx + 2] = 0;

      const mask = await detectCornerConnectedLineMask(ctx);

      let maskCount = 0;
      for (let i = 0; i < mask.length; i++) if (mask[i]) maskCount++;

      // Should filter out small noise because it looks for lines
      expect(maskCount).toBe(0);
    });
  });

  describe("detectStrokeMask", () => {
    test("should detect markers", async () => {
      const width = 100;
      const height = 100;
      const ctx = await createContext(width, height);

      // Draw a Yellow/Orange marker stroke
      // 255, 165, 0
      drawLine(ctx.pixels, width, 30, 30, 70, 70, [255, 165, 0]); // Diagonal? Helper only supports H/V.
      // Let's draw H and V cross
      drawLine(ctx.pixels, width, 30, 50, 70, 50, [255, 165, 0]);
      drawLine(ctx.pixels, width, 50, 30, 50, 70, [255, 165, 0]);

      const mask = await detectStrokeMask(ctx);
      let maskCount = 0;
      for (let i = 0; i < mask.length; i++) if (mask[i]) maskCount++;

      expect(maskCount).toBeGreaterThan(10);
    });
  });
});

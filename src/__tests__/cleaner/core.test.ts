import { describe, expect, test } from "bun:test";
import type { CleanerContext } from "../../lib/cleaner/core/context";
import { inpaintMask, smoothChangedPixels } from "../../lib/cleaner/core/inpaint";

// Minimal mock for CleanerContext
const createMockContext = (width: number, height: number): CleanerContext => {
  const pixels = new Uint8Array(width * height * 4);
  const changed = new Uint8Array(width * height);
  // Initialize with white background
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 255;
    pixels[i + 1] = 255;
    pixels[i + 2] = 255;
    pixels[i + 3] = 255;
  }
  return {
    pixels,
    changed,
    width,
    height,
    info: { width, height },
    isComplexScene: false,
    // biome-ignore lint/suspicious/noExplicitAny: Mocking sharp
    sharp: {} as any, // Not used by inpaintMask/smoothChangedPixels
  };
};

describe("Cleaner Core: Inpaint", () => {
  test("inpaintMask should fill masked area using surrounding pixels", () => {
    const width = 10;
    const height = 10;
    const ctx = createMockContext(width, height);
    const mask = new Uint8Array(width * height);

    // Set a block in the middle to be masked
    // 3,3 to 5,5 is mask
    for (let y = 3; y <= 5; y++) {
      for (let x = 3; x <= 5; x++) {
        mask[y * width + x] = 1;
        // set underlying pixels to RED to simulate garbage that should be overwritten
        const idx = (y * width + x) * 4;
        ctx.pixels[idx] = 255;
        ctx.pixels[idx + 1] = 0;
        ctx.pixels[idx + 2] = 0;
      }
    }

    // Neighbors are 255,255,255 (White)

    const fallbackCount = inpaintMask(ctx, mask);
    // expect(fallbackCount).toBeGreaterThan(0); // This only counts fallback repairs, main pass repairs are not counted in return value

    // Check center pixel is now white-ish (not red)
    const cx = 4;
    const cy = 4;
    const cIdx = (cy * width + cx) * 4;
    expect(ctx.pixels[cIdx]).toBeGreaterThan(200); // R
    expect(ctx.pixels[cIdx + 1]).toBeGreaterThan(200); // G
    expect(ctx.pixels[cIdx + 2]).toBeGreaterThan(200); // B

    // Mask should be cleared
    expect(mask[cy * width + cx]).toBe(0);
    // Changed should be marked
    expect(ctx.changed[cy * width + cx]).toBe(1);
  });
});

describe("Cleaner Core: Smooth", () => {
  test("smoothChangedPixels should blend changed pixels", () => {
    const width = 10;
    const height = 10;
    const ctx = createMockContext(width, height);

    // Set a pixel as "changed" and verify it gets smoothed
    const cx = 5;
    const cy = 5;
    const idx = (cy * width + cx) * 4;

    // Changed pixel is Black
    ctx.pixels[idx] = 0;
    ctx.pixels[idx + 1] = 0;
    ctx.pixels[idx + 2] = 0;
    ctx.changed[cy * width + cx] = 1;

    // Neighbors are White (255)

    smoothChangedPixels(ctx);

    // After smoothing, the black pixel should become lighter (blended with neighbors)
    expect(ctx.pixels[idx]).toBeGreaterThan(50);
  });
});

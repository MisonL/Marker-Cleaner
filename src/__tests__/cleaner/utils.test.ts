import { describe, expect, test } from "bun:test";
import { estimateTextureComplexity, mergeBoxes, toPixelRect } from "../../lib/cleaner/utils/image";
import type { BoundingBox } from "../../lib/types";

describe("Cleaner Image Utils", () => {
  describe("toPixelRect", () => {
    test("should convert normalized coordinates to pixels correctly", () => {
      const box: BoundingBox = { xmin: 0.1, ymin: 0.1, xmax: 0.9, ymax: 0.9 };
      const width = 100;
      const height = 100;
      const padding = 0;

      const rect = toPixelRect(box, width, height, padding);

      expect(rect.x1).toBe(10);
      expect(rect.y1).toBe(10);
      expect(rect.x2).toBe(90);
      expect(rect.y2).toBe(90);
    });

    test("should apply padding and clamp to boundaries", () => {
      const box: BoundingBox = { xmin: 0, ymin: 0, xmax: 1, ymax: 1 };
      const width = 100;
      const height = 100;
      const padding = 5;

      const rect = toPixelRect(box, width, height, padding);

      expect(rect.x1).toBe(0); // Clamped
      expect(rect.y1).toBe(0); // Clamped
      expect(rect.x2).toBe(100); // Clamped (min(100, 100+5))
      expect(rect.y2).toBe(100);
    });

    test("should handle padding normally when not at boundaries", () => {
      const box: BoundingBox = { xmin: 0.5, ymin: 0.5, xmax: 0.6, ymax: 0.6 };
      const width = 200;
      const height = 200;
      const padding = 10;

      // 0.5 * 200 = 100. padding 10 -> 90
      const rect = toPixelRect(box, width, height, padding);
      expect(rect.x1).toBe(90);
      expect(rect.y1).toBe(90);
    });
  });

  describe("mergeBoxes", () => {
    test("should merge overlapping boxes", () => {
      const base: BoundingBox[] = [{ xmin: 0.1, ymin: 0.1, xmax: 0.5, ymax: 0.5 }];
      const extra: BoundingBox[] = [{ xmin: 0.4, ymin: 0.4, xmax: 0.8, ymax: 0.8 }];

      // Overlap area: (0.5-0.4)*(0.5-0.4) = 0.01
      // Union: 0.4*0.4*2 - 0.01 = 0.31
      // IoU = 0.01 / 0.31 = 0.03 (Very small)

      // Wait, the mergeBoxes logic has a threshold.
      // let's adjust to have high overlap.
      const extraHighOverlap: BoundingBox[] = [{ xmin: 0.15, ymin: 0.15, xmax: 0.45, ymax: 0.45 }];
      // This is inside base. IoU will be (0.3*0.3) / (0.4*0.4) = 0.09 / 0.16 = 0.5625
      // Threshold is overlap > 0.75 OR (overlap > 0.55 && ratio > 0.55)
      // ratio = minArea/maxArea = 0.09/0.16 = 0.5625
      // So it should merge.

      const merged = mergeBoxes(base, extraHighOverlap);
      expect(merged.length).toBe(1);
      // It takes min/max union
      const first = merged[0];
      expect(first).toBeDefined();
      if (!first) return;
      expect(first.xmin).toBe(0.1);
      expect(first.xmax).toBe(0.5);
    });

    test("should not merge distant boxes", () => {
      const base: BoundingBox[] = [{ xmin: 0.1, ymin: 0.1, xmax: 0.2, ymax: 0.2 }];
      const extra: BoundingBox[] = [{ xmin: 0.8, ymin: 0.8, xmax: 0.9, ymax: 0.9 }];

      const merged = mergeBoxes(base, extra);
      expect(merged.length).toBe(2);
    });
  });

  describe("estimateTextureComplexity", () => {
    test("should returns 0 for flat color", () => {
      const width = 20;
      const height = 20;
      const pixels = new Uint8Array(width * height * 4);
      // All black
      const score = estimateTextureComplexity(pixels, width, height);
      expect(score).toBe(0);
    });

    test("should return > 0 for noise", () => {
      const width = 20;
      const height = 20;
      const pixels = new Uint8Array(width * height * 4);
      for (let i = 0; i < pixels.length; i += 4) {
        pixels[i] = Math.random() * 255;
        pixels[i + 1] = Math.random() * 255;
        pixels[i + 2] = Math.random() * 255;
      }
      const score = estimateTextureComplexity(pixels, width, height);
      expect(score).toBeGreaterThan(0);
    });
  });
});

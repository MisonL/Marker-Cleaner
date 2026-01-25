import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { cleanMarkersLocal } from "../lib/cleaner";

describe("cleanMarkersLocal", () => {
  test("应能清除红色矩形边框且不破坏框内内容", async () => {
    const width = 200;
    const height = 200;

    const pixels = new Uint8Array(width * height * 4);
    const setPixel = (x: number, y: number, r: number, g: number, b: number, a = 255) => {
      const idx = (y * width + x) * 4;
      pixels[idx] = r;
      pixels[idx + 1] = g;
      pixels[idx + 2] = b;
      pixels[idx + 3] = a;
    };

    // 背景：近白色（避免边缘采样不稳定）
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) setPixel(x, y, 248, 248, 248, 255);
    }

    // 红色矩形边框（模拟标记框）
    const x1 = 30;
    const y1 = 40;
    const x2 = 170;
    const y2 = 160;
    const thickness = 2;

    for (let t = 0; t < thickness; t++) {
      // top/bottom
      for (let x = x1; x <= x2; x++) {
        setPixel(x, y1 + t, 255, 40, 40, 255);
        setPixel(x, y2 - t, 255, 40, 40, 255);
      }
      // left/right
      for (let y = y1; y <= y2; y++) {
        setPixel(x1 + t, y, 255, 40, 40, 255);
        setPixel(x2 - t, y, 255, 40, 40, 255);
      }
    }

    // 框内内容：绿色块（确保不会被误伤）
    for (let y = 95; y <= 105; y++) {
      for (let x = 95; x <= 105; x++) setPixel(x, y, 40, 210, 80, 255);
    }

    const inputBuffer = await sharp(pixels, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer();

    // 模拟 Detection 模式：bbox 偏松一些（更贴近真实模型输出）
    const pad = 10;
    const box = {
      ymin: (y1 - pad) / height,
      xmin: (x1 - pad) / width,
      ymax: (y2 + pad) / height,
      xmax: (x2 + pad) / width,
    };

    const { outputBuffer } = await cleanMarkersLocal(inputBuffer, [box]);

    const decoded = await sharp(outputBuffer)
      .raw()
      .ensureAlpha()
      .toBuffer({ resolveWithObject: true });
    const out = new Uint8Array(decoded.data);

    const isStrongRed = (r: number, g: number, b: number) =>
      r >= 220 && r - g >= 80 && r - b >= 80 && g <= 140 && b <= 140;

    let redCount = 0;
    for (let i = 0; i < out.length; i += 4) {
      const r = out[i] ?? 0;
      const g = out[i + 1] ?? 0;
      const b = out[i + 2] ?? 0;
      if (isStrongRed(r, g, b)) redCount++;
    }

    // PNG 理论上应为 0；这里给一点余量，避免后续算法微调导致脆弱失败
    expect(redCount).toBeLessThanOrEqual(30);

    // 框内绿色块应仍然是绿色（采样中心点）
    const cx = 100;
    const cy = 100;
    const cIdx = (cy * width + cx) * 4;
    const cr = out[cIdx] ?? 0;
    const cg = out[cIdx + 1] ?? 0;
    const cb = out[cIdx + 2] ?? 0;
    expect(cg).toBeGreaterThan(180);
    expect(cr).toBeLessThan(120);
    expect(cb).toBeLessThan(160);
  });
});

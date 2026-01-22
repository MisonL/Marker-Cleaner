import { describe, expect, test } from "bun:test";
import {
  detectMimeType,
  getPlatformInfo,
  normalizePath,
  parseBoxesFromText,
} from "../lib/utils";
import { join } from "node:path";

describe("normalizePath", () => {
  test("should handle file:// URLs and fallbacks", () => {
    // Unix-style
    if (process.platform !== "win32") {
      expect(normalizePath("file:///tmp/test.png")).toBe("/tmp/test.png");
    }
    // 非标准 file:// 容错处理：确保至少能剥离协议头并识别盘符
    const result = normalizePath("file://C:/tmp/test.png");
    expect(result.endsWith("C:/tmp/test.png")).toBe(true);
  });

  test("should handle absolute paths", () => {
    if (process.platform !== "win32") {
      expect(normalizePath("/abs/path.png")).toBe("/abs/path.png");
    } else {
      expect(normalizePath("C:\\abs\\path.png")).toBe("C:\\abs\\path.png");
      expect(normalizePath("C:/abs/path.png")).toBe("C:/abs/path.png");
      expect(normalizePath("\\\\server\\share")).toBe("\\\\server\\share");
    }
  });

  test("should handle Windows drive-relative paths as relative", () => {
    const base = "/base";
    // C:foo 应该被视为相对路径并拼接 baseDir (尽管在真正 Windows 上 C:foo 有盘符含义，但在跨平台工具中我们遵循非绝对即相对原则)
    expect(normalizePath("C:foo", base)).toBe(join(base, "C:foo"));
  });

  test("should handle relative paths with baseDir", () => {
    const base = "/base";
    expect(normalizePath("rel/path.png", base)).toBe(join(base, "rel/path.png"));
  });

  test("should handle empty or null input", () => {
    expect(normalizePath("")).toBe("");
    expect(normalizePath("  ")).toBe("");
    expect(normalizePath("", "/base")).toBe("");
  });
});

describe("detectMimeType", () => {
  test("should detect PNG format", () => {
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detectMimeType(pngBuffer)).toBe("image/png");
  });

  test("should detect JPEG format", () => {
    const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    expect(detectMimeType(jpegBuffer)).toBe("image/jpeg");
  });

  test("should detect WebP format", () => {
    const webpBuffer = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    expect(detectMimeType(webpBuffer)).toBe("image/webp");
  });

  test("should default to PNG for unknown format", () => {
    const unknownBuffer = Buffer.from([0x00, 0x00, 0x00, 0x00]);
    expect(detectMimeType(unknownBuffer)).toBe("image/png");
  });
});

describe("parseBoxesFromText", () => {
  test("should parse valid JSON array with bounding boxes", () => {
    const text = 'Here are the boxes: [{"ymin": 0.1, "xmin": 0.2, "ymax": 0.3, "xmax": 0.4}]';
    const boxes = parseBoxesFromText(text);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toEqual({ ymin: 0.1, xmin: 0.2, ymax: 0.3, xmax: 0.4 });
  });

  test("should parse multiple bounding boxes", () => {
    const text =
      '[{"ymin": 0.1, "xmin": 0.1, "ymax": 0.2, "xmax": 0.2}, {"ymin": 0.5, "xmin": 0.5, "ymax": 0.6, "xmax": 0.6}]';
    const boxes = parseBoxesFromText(text);
    expect(boxes).toHaveLength(2);
  });

  test("should return empty array for invalid JSON", () => {
    const text = "No valid JSON here";
    const boxes = parseBoxesFromText(text);
    expect(boxes).toHaveLength(0);
  });

  test("should filter out invalid box objects", () => {
    const text =
      '[{"ymin": 0.1, "xmin": 0.2}, {"ymin": 0.1, "xmin": 0.2, "ymax": 0.3, "xmax": 0.4}]';
    const boxes = parseBoxesFromText(text);
    expect(boxes).toHaveLength(1);
  });

  test("should return empty array for empty input", () => {
    const boxes = parseBoxesFromText("");
    expect(boxes).toHaveLength(0);
  });
});

describe("getPlatformInfo", () => {
  test("should return platform and arch", () => {
    const { platform, arch } = getPlatformInfo();
    expect(typeof platform).toBe("string");
    expect(typeof arch).toBe("string");
    expect(["windows", "macos", "linux"]).toContain(platform);
  });
});

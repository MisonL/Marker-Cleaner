import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  base64URLEncode,
  detectMimeType,
  formatDuration,
  getPlatformInfo,
  isExplicitEmptyBoxesResponse,
  normalizePath,
  parseBoxesFromText,
  renderImageToTerminal,
  sha256,
} from "../lib/utils";

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

  test("should normalize qwen-style bbox_2d 0-1000 coordinates", () => {
    const text = '```json\\n[{"bbox_2d":[100,200,300,400]}]\\n```';
    const boxes = parseBoxesFromText(text);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toEqual({ ymin: 0.2, xmin: 0.1, ymax: 0.4, xmax: 0.3 });
  });

  test("should parse a single bbox array output", () => {
    const text = "[100,200,300,400]";
    const boxes = parseBoxesFromText(text);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toEqual({ ymin: 0.2, xmin: 0.1, ymax: 0.4, xmax: 0.3 });
  });

  test("should handle reversed ymin/ymax or xmin/xmax and clamp", () => {
    const text = '[{"ymin": 2, "xmin": 1.2, "ymax": -1, "xmax": 0.1}]';
    const boxes = parseBoxesFromText(text);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toEqual({ ymin: 0, xmin: 0.1, ymax: 1, xmax: 1 });
  });

  test("should recover bbox arrays mistakenly placed under ymin field", () => {
    const text = '[{"ymin":[439,326,500,413],"label":"x"}]';
    const boxes = parseBoxesFromText(text);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toEqual({ ymin: 0.439, xmin: 0.326, ymax: 0.5, xmax: 0.413 });
  });

  test("should handle boxes object with arrays in numeric fields (qwen weird output)", () => {
    const text =
      '{"boxes":[{"ymin":[415,206,508,331],"xmin":[440,329,508,427],"ymax":[0,806,132,974],"xmax":[0,0,0,0]}]}';
    const boxes = parseBoxesFromText(text);
    expect(boxes.length).toBeGreaterThan(0);
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

describe("isExplicitEmptyBoxesResponse", () => {
  test("should detect explicit empty boxes object", () => {
    expect(isExplicitEmptyBoxesResponse('{"boxes":[]}')).toBe(true);
  });

  test("should detect explicit empty array", () => {
    expect(isExplicitEmptyBoxesResponse("[]")).toBe(true);
  });

  test("should not mis-detect when JSON is not pure", () => {
    expect(isExplicitEmptyBoxesResponse("note: []")).toBe(false);
  });

  test("should handle fenced json", () => {
    expect(isExplicitEmptyBoxesResponse('```json\n{"boxes": []}\n```')).toBe(true);
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

describe("formatDuration", () => {
  test("should format milliseconds to readable string", () => {
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(61000)).toBe("1m 1s");
    expect(formatDuration(3661000)).toBe("1h 1m 1s");
    expect(formatDuration(3600000)).toBe("1h 0m 0s");
  });
});

describe("base64URLEncode", () => {
  test("should encode buffer to base64url", () => {
    const buffer = Buffer.from("Hello+World/Test?");
    const encoded = base64URLEncode(buffer);
    // Base64: SGVsbG8rV29ybGQvVGVzdD8=
    // URL Safe: SGVsbG8rV29ybGQvVGVzdD8 (our impl replaces + with - and / with _)
    // Wait, our impl:
    // .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
    // 'SGVsbG8rV29ybGQvVGVzdD8=' -> 'SGVsbG8-V29ybGQ_VGVzdD8'
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
  });
});

describe("renderImageToTerminal", () => {
  test("should return placeholder when not in iTerm2", () => {
    const originalTerm = process.env.TERM_PROGRAM;
    process.env.TERM_PROGRAM = undefined;

    const buffer = Buffer.from("test");
    const output = renderImageToTerminal(buffer);
    expect(output).toBe("🖼️ [Image]");

    process.env.TERM_PROGRAM = originalTerm;
  });

  test("should return iTerm2 sequence when in iTerm2", () => {
    const originalTerm = process.env.TERM_PROGRAM;
    process.env.TERM_PROGRAM = "iTerm.app";

    const buffer = Buffer.from("test");
    const output = renderImageToTerminal(buffer);
    expect(output).toContain("\x1b]1337;File=inline=1");

    process.env.TERM_PROGRAM = originalTerm;
  });
});

describe("sha256", () => {
  test("should return correct hash", () => {
    const buffer = Buffer.from("test");
    const hash = sha256(buffer);
    expect(hash.toString("hex")).toBe(
      "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    );
  });
});

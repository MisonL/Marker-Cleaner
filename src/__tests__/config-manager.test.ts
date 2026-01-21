import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 测试 schema 验证
import { ConfigSchema } from "../lib/config-manager";

describe("ConfigSchema", () => {
  test("should parse empty object with defaults", () => {
    const config = ConfigSchema.parse({});
    expect(config.inputDir).toBe("./input");
    expect(config.outputDir).toBe("./output");
    expect(config.provider).toBe("antigravity");
    expect(config.recursive).toBe(true);
    expect(config.preserveStructure).toBe(true);
  });

  test("should accept valid provider values", () => {
    const googleConfig = ConfigSchema.parse({ provider: "google" });
    expect(googleConfig.provider).toBe("google");

    const openaiConfig = ConfigSchema.parse({ provider: "openai" });
    expect(openaiConfig.provider).toBe("openai");

    const antigravityConfig = ConfigSchema.parse({ provider: "antigravity" });
    expect(antigravityConfig.provider).toBe("antigravity");
  });

  test("should reject invalid provider values", () => {
    expect(() => ConfigSchema.parse({ provider: "invalid" })).toThrow();
  });

  test("should accept valid output format values", () => {
    const formats = ["original", "png", "jpg", "webp"] as const;
    for (const format of formats) {
      const config = ConfigSchema.parse({ outputFormat: format });
      expect(config.outputFormat).toBe(format);
    }
  });

  test("should include default prompts", () => {
    const config = ConfigSchema.parse({});
    expect(config.prompts.edit).toBeDefined();
    expect(config.prompts.detect).toBeDefined();
    expect(typeof config.prompts.edit).toBe("string");
    expect(typeof config.prompts.detect).toBe("string");
  });

  test("should include default pricing", () => {
    const config = ConfigSchema.parse({});
    expect(config.pricing.inputTokenPer1M).toBe(0.15);
    expect(config.pricing.outputTokenPer1M).toBe(0.6);
    expect(config.pricing.imageOutput).toBe(0.039);
  });

  test("should allow custom pricing", () => {
    const config = ConfigSchema.parse({
      pricing: {
        inputTokenPer1M: 0.5,
        outputTokenPer1M: 1.0,
        imageOutput: 0.1,
      },
    });
    expect(config.pricing.inputTokenPer1M).toBe(0.5);
  });
});

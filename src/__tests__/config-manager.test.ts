import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as configManager from "../lib/config-manager";
import { ConfigSchema } from "../lib/config-manager";

// Mock homedir to use a temp directory
const TEST_DIR = join(process.cwd(), "test-temp-config");

// Mocking os module is tricky in Bun with ESM, so we'll try to rely on
// the fact that we can manipulate where getConfigDir looks or just test logic that accepts paths if possible.
// But getConfigDir is hardcoded.
// Strategy: We will mock `homedir` by mocking the module `node:os`.

mock.module("node:os", () => {
  return {
    homedir: () => TEST_DIR,
    tmpdir: () => "/tmp",
  };
});

describe("ConfigManager", () => {
  // Setup and Teardown
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe("ConfigSchema", () => {
    test("should parse empty object with defaults", () => {
      const config = ConfigSchema.parse({});
      expect(config.inputDir).toBe("./input");
      expect(config.outputDir).toBe("./output");
      expect(config.provider).toBe("antigravity");
    });

    test("should reject invalid provider", () => {
      expect(() => ConfigSchema.parse({ provider: "invalid" })).toThrow();
    });
  });

  describe("File Operations", () => {
    test("getConfigDir should return path inside mocked homedir", () => {
      // Note: This test depends on process.platform.
      // On macOS it should be join(TEST_DIR, ".marker-cleaner")
      // On Linux it might differ if XDG_CONFIG_HOME is set, but we mocked homedir.
      // Let's just check it contains TEST_DIR.
      const dir = configManager.getConfigDir();
      expect(dir).toContain(TEST_DIR);
    });

    test("loadConfig should return default config if file does not exist", () => {
      const config = configManager.loadConfig();
      expect(config.provider).toBe("antigravity");
      // Should create the file
      const dir = configManager.getConfigDir();
      expect(existsSync(join(dir, "marker-cleaner.json"))).toBe(true);
    });

    test("loadConfig should load existing config", () => {
      const dir = configManager.getConfigDir();
      const dummyConfig = {
        ...configManager.getDefaultConfig(),
        provider: "openai" as const,
        apiKey: "test-key",
      };
      writeFileSync(join(dir, "marker-cleaner.json"), JSON.stringify(dummyConfig));

      const config = configManager.loadConfig();
      expect(config.provider).toBe("openai");
      expect(config.apiKey).toBe("test-key");
    });

    test("loadConfig should repair invalid config", () => {
      const dir = configManager.getConfigDir();
      const invalidConfig = {
        provider: "invalid-provider",
      };
      // @ts-ignore
      writeFileSync(join(dir, "marker-cleaner.json"), JSON.stringify(invalidConfig));

      // Should fallback to default or repair
      const config = configManager.loadConfig();
      expect(config.provider).toBe("antigravity"); // Default
    });

    test("saveConfig should write config to file", () => {
      const config = configManager.getDefaultConfig();
      config.provider = "google";
      configManager.saveConfig(config);

      const dir = configManager.getConfigDir();
      const content = JSON.parse(readFileSync(join(dir, "marker-cleaner.json"), "utf-8"));
      expect(content.provider).toBe("google");
    });

    test("resetConfig should restore defaults", () => {
      const config = configManager.getDefaultConfig();
      config.provider = "google";
      configManager.saveConfig(config);

      const newConfig = configManager.resetConfig();
      expect(newConfig.provider).toBe("antigravity");

      const dir = configManager.getConfigDir();
      const content = JSON.parse(readFileSync(join(dir, "marker-cleaner.json"), "utf-8"));
      expect(content.provider).toBe("antigravity");
    });
  });

  describe("Progress Management", () => {
    test("loadProgress should return default if no file", () => {
      const progress = configManager.loadProgress();
      expect(progress.totalInputTokens).toBe(0);
      expect(progress.processedFiles).toEqual([]);
    });

    test("saveProgress and loadProgress", () => {
      const progress = {
        processedFiles: ["file1.jpg"],
        totalInputTokens: 100,
        totalOutputTokens: 200,
        totalImageOutputs: 1,
        totalCost: 0.5,
        lastUpdated: new Date().toISOString(),
      };
      configManager.saveProgress(progress);

      const loaded = configManager.loadProgress();
      expect(loaded.processedFiles).toContain("file1.jpg");
      expect(loaded.totalInputTokens).toBe(100);
    });

    test("clearProgress should reset progress", () => {
      const progress = {
        processedFiles: ["file1.jpg"],
        totalInputTokens: 100,
        totalOutputTokens: 200,
        totalImageOutputs: 1,
        totalCost: 0.5,
        lastUpdated: new Date().toISOString(),
      };
      configManager.saveProgress(progress);

      configManager.clearProgress();
      const loaded = configManager.loadProgress();
      expect(loaded.processedFiles).toEqual([]);
      expect(loaded.totalCost).toBe(0);
    });
  });
});

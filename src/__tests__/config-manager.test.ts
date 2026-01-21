import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as configManager from "../lib/config-manager";
import { ConfigSchema } from "../lib/config-manager";

// 模拟 homedir 使用临时目录
const TEST_DIR = join(process.cwd(), "test-temp-config");

// 在 Bun ESM 环境中 Mock os 模块比较棘手，所以我们模拟
// getConfigDir 的行为或者尽可能测试接受路径的逻辑。
// 但是 getConfigDir 是硬编码的。
// 策略：我们通过 mock `node:os` 模块来模拟 `homedir`。

mock.module("node:os", () => {
  return {
    homedir: () => TEST_DIR,
    tmpdir: () => "/tmp",
  };
});

describe("ConfigManager", () => {
  // 设置与清理
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
    test("应解析带有默认值的空对象", () => {
      const config = ConfigSchema.parse({});
      expect(config.inputDir).toBe("./input");
      expect(config.outputDir).toBe("./output");
      expect(config.provider).toBe("antigravity");
    });

    test("应拒绝无效的 provider", () => {
      expect(() => ConfigSchema.parse({ provider: "invalid" })).toThrow();
    });
  });

  describe("文件操作", () => {
    test("getConfigDir 应返回模拟 homedir 中的路径", () => {
      // 注意：此测试依赖于 process.platform。
      // 在 macOS 上应为 join(TEST_DIR, ".marker-cleaner")
      // 在 Linux 上若设置了 XDG_CONFIG_HOME 可能不同，但我们 mock 了 homedir。
      // 我们只检查它包含 TEST_DIR。
      const dir = configManager.getConfigDir();
      expect(dir).toContain(TEST_DIR);
    });

    test("loadConfig 若文件不存在应返回默认配置", () => {
      const config = configManager.loadConfig();
      expect(config.provider).toBe("antigravity");
      // 应该创建文件
      const dir = configManager.getConfigDir();
      expect(existsSync(join(dir, "marker-cleaner.json"))).toBe(true);
    });

    test("loadConfig 应加载现有配置", () => {
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

    test("loadConfig 应修复无效配置", () => {
      const dir = configManager.getConfigDir();
      const invalidConfig = {
        provider: "invalid-provider",
      };
      // @ts-ignore
      writeFileSync(join(dir, "marker-cleaner.json"), JSON.stringify(invalidConfig));

      // 应该回退到默认值或修复
      const config = configManager.loadConfig();
      expect(config.provider).toBe("antigravity"); // Default
    });

    test("saveConfig 应将配置写入文件", () => {
      const config = configManager.getDefaultConfig();
      config.provider = "google";
      configManager.saveConfig(config);

      const dir = configManager.getConfigDir();
      const content = JSON.parse(readFileSync(join(dir, "marker-cleaner.json"), "utf-8"));
      expect(content.provider).toBe("google");
    });

    test("resetConfig 应恢复默认值", () => {
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

  describe("进度管理", () => {
    test("loadProgress 若无文件应返回默认值", () => {
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

    test("clearProgress 应重置进度", () => {
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

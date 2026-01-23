import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"; // 新增导入
import { basename, dirname, extname, join } from "node:path"; // 新增导入
import { Box, Text, render, useApp, useInput } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import pkg from "../package.json";
import { createProvider } from "./lib/ai";
import { loginWithAntigravity } from "./lib/antigravity/auth";
import { AntigravityProvider, type QuotaStatus } from "./lib/antigravity/provider";
import { tokenPool } from "./lib/antigravity/token-pool";
import { DependencyManager, type PackageManager } from "./lib/deps-manager"; // Update import
function isAntigravityProvider(provider: unknown): provider is AntigravityProvider {
  return provider instanceof AntigravityProvider;
}
import { ResumeCheckScreen, type ResumeState } from "./components/ResumeCheckScreen";
import { BatchProcessor } from "./lib/batch-processor";
import {
  type Config,
  clearProgress,
  getDefaultConfig,
  loadConfig,
  resetConfig,
  saveConfig,
} from "./lib/config-manager";
import { createLogger } from "./lib/logger";
import { getThemeColors } from "./lib/theme";
import type { BatchTask } from "./lib/types";
import { formatDuration, normalizePath, openPath, renderImageToTerminal } from "./lib/utils";

// ============ Hooks ============

function useShortcuts(params: {
  screen: Screen;
  onExit: () => void;
  onNavigate: (screen: Screen) => void;
  onSelectMenu: (index: number) => void;
  onOpenReport?: () => void;
  canOpenReport: boolean;
  isEditing?: boolean;
}) {
  const { screen, onExit, onNavigate, onSelectMenu, onOpenReport, canOpenReport, isEditing } =
    params;

  useInput(async (input, key) => {
    // 如果正在编辑（如 TextInput 中），跳过全局快捷键
    if (isEditing) return;

    const lowerInput = input.toLowerCase();

    // 通用退出逻辑
    if (key.escape || lowerInput === "q") {
      if (screen !== "menu") {
        onNavigate("menu");
      } else {
        onExit();
      }
    }

    // 主菜单快捷键
    if (screen === "menu") {
      if (lowerInput === "s") onSelectMenu(0);
      if (lowerInput === "f") onSelectMenu(1);
      if (lowerInput === "c") onSelectMenu(2);
      if (lowerInput === "r") onSelectMenu(3);
    }

    // 完成页快捷键
    if (screen === "done" && key.return && canOpenReport) {
      onOpenReport?.();
    }

    // 安装依赖快捷键 (Menu only)
    // We handle this via a callback prop passed down or directly here if we had access.
    // Since useShortcuts is generic, we'll handle specific 'i' key separately in the main component logic or pass a handler.
  });
}

// ============ 依赖检测 (Removed raw check, moved to component) ============

type Screen = "menu" | "config" | "process" | "done" | "file-selection" | "resume-check";

// ============ 恢复任务检查界面 (Moved to components/ResumeCheckScreen.tsx) ============

// ============ 单文件选择界面 ============

interface FileSelectionScreenProps {
  inputDir: string;
  onSelect: (path: string) => void;
  onCancel: () => void;
  onEditingChange?: (isEditing: boolean) => void;
  isLight?: boolean;
}

const FileSelectionScreen: React.FC<FileSelectionScreenProps> = ({
  inputDir,
  onSelect,
  onCancel,
  onEditingChange,
  isLight,
}) => {
  const [files, setFiles] = useState<{ label: string; value: string }[]>([]);

  useEffect(() => {
    try {
      if (existsSync(inputDir)) {
        const items = require("node:fs").readdirSync(inputDir);
        const imageFiles = items
          .filter((f: string) => /\.(png|jpe?g|webp)$/i.test(f))
          .map((f: string) => ({ label: f, value: join(inputDir, f) }));
        setFiles(imageFiles);
      }
    } catch {}
  }, [inputDir]);

  const { bg, accent, dim } = getThemeColors(!!isLight);

  return (
    <Box flexDirection="column" backgroundColor={bg}>
      <Box paddingX={2} flexDirection="column" backgroundColor={bg}>
        <Box marginBottom={1} backgroundColor={bg}>
          <Text bold color={accent} backgroundColor={bg}>
            🖼️ 单文件处理
          </Text>
        </Box>
        <Box marginBottom={1} backgroundColor={bg}>
          <Text color={dim} backgroundColor={bg}>
            请选择文件或输入路径 (Esc 返回)
          </Text>
        </Box>

        <FileSelectorWithInput
          files={files.map((f) => f.label)}
          value=""
          onSelect={(file) => {
            // 如果是列表选择的，file 是文件名。如果是手动输入的，可能是路径。
            const found = files.find((f) => f.label === file);
            if (found) {
              onSelect(found.value);
            } else {
              // 手动输入处理
              const fullPath = normalizePath(file, inputDir);
              onSelect(fullPath);
            }
          }}
          onCancel={onCancel}
          onEditingChange={onEditingChange}
          isLight={isLight}
        />
      </Box>
    </Box>
  );
};

// 为 FileSelector 添加独立的 Hook wrapper
function FileSelectorWithInput(props: {
  files: string[];
  value: string;
  onSelect: (file: string) => void;
  onCancel: () => void;
  onEditingChange?: (isEditing: boolean) => void;
  isLight?: boolean;
}) {
  const [mode, setMode] = useState<"list" | "manual">("list");
  const [manualPath, setManualPath] = useState(props.value);

  useEffect(() => {
    props.onEditingChange?.(mode === "manual");
  }, [mode, props.onEditingChange]);

  useInput((input, key) => {
    if (key.tab) {
      setMode((prev) => (prev === "list" ? "manual" : "list"));
    }
    if (key.escape) {
      props.onCancel();
    }
  });

  const { dim, bg } = getThemeColors(!!props.isLight);

  return (
    <Box flexDirection="column">
      {mode === "list" ? (
        <SelectInput
          items={props.files.map((f) => ({ label: f, value: f }))}
          onSelect={(item) => props.onSelect(item.value)}
        />
      ) : (
        <Box flexDirection="column" backgroundColor={bg}>
          <Box backgroundColor={bg}>
            <Text backgroundColor={bg}>📁 手动输入路径: </Text>
            <TextInput
              value={manualPath}
              onChange={setManualPath}
              onSubmit={() => {
                const trimmed = manualPath.trim();
                if (trimmed) {
                  props.onSelect(trimmed);
                }
              }}
            />
          </Box>
          <Box marginTop={1} flexDirection="column" backgroundColor={bg}>
            <Text color={dim} backgroundColor={bg}>
              支持相对路径 (如 ./test.jpg) 或绝对路径
            </Text>
            <Text color={dim} backgroundColor={bg}>
              按 Enter 确认，按 Tab 切换回列表
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}

// Simple text-based progress bar component
const FakeProgressBar = ({ percent, isLight }: { percent: number; isLight?: boolean }) => {
  const width = 30;
  const completed = Math.floor((width * percent) / 100);
  const remaining = width - completed;
  return (
    <Text color={isLight ? "blue" : "green"}>
      {"["}
      {"█".repeat(completed)}
      {"░".repeat(remaining)}
      {"]"} {percent}%
    </Text>
  );
};

interface MenuItem {
  label: string;
  value: string;
  icon?: string;
}

interface ConfigScreenProps {
  config: Config;
  onSave: (config: Config) => void;
  onCancel: () => void;
  onEditingChange?: (isEditing: boolean) => void;
  logger: ReturnType<typeof createLogger>;
  isLight?: boolean;
}

interface ConfigField {
  key: string; // 改为 string 以支持嵌套键
  label: string;
  type: "text" | "password" | "boolean" | "select";
  options?: string[];
  advanced?: boolean;
}

const getModelOptions = (provider: string) => {
  if (provider === "antigravity") {
    return [
      "gemini-3-pro-image", // Native
      "gemini-3-flash", // Detection
      "gemini-3-pro-high", // Detection
      "gemini-3-pro-low", // Detection
      "gemini-2.5-flash-image", // Native
      "claude-sonnet-4-5", // Detection
    ];
  }
  if (provider === "google") {
    return [
      "gemini-2.5-flash-image", // Native
      "gemini-2.0-flash-exp", // Native
      "gemini-1.5-pro", // Detection
      "gemini-1.5-flash", // Detection
      "(Manual Input)", // 允许手动输入
    ];
  }
  if (provider === "openai") {
    return [
      "gpt-4o", // Detection
      "gpt-4-turbo", // Detection
      "(Manual Input)",
    ];
  }
  return ["(Manual Input)"];
};

const ConfigScreen: React.FC<ConfigScreenProps> = ({
  config,
  onSave,
  onCancel,
  onEditingChange,
  logger,
  isLight,
}) => {
  const [editConfig, setEditConfig] = useState<Config>({ ...config });
  const [isEditing, setIsEditing] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const [authState, setAuthState] = useState(tokenPool.getTokens()[0]);
  const [loginMsg, setLoginMsg] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const [manualModelMode, setManualModelMode] = useState(false);

  useEffect(() => {
    onEditingChange?.(isEditing);
  }, [isEditing, onEditingChange]);

  const { bg, fg, dim, accent, warning, danger, success } = getThemeColors(!!isLight);

  useEffect(() => {
    if (editConfig.provider === "antigravity" && authState) {
      const provider = createProvider(editConfig);
      if (isAntigravityProvider(provider)) {
        provider
          .getQuota()
          .then(setQuota)
          .catch(() => {});
      }
    }
  }, [editConfig, authState]);

  /* biome-ignore lint/suspicious/noExplicitAny: Dynamic configuration access */
  const getNestedValue = (obj: any, path: string) => {
    return path.split(".").reduce((acc, part) => acc?.[part], obj);
  };

  /* biome-ignore lint/suspicious/noExplicitAny: Dynamic configuration update */
  const setNestedValue = (obj: any, path: string, value: any) => {
    const parts = path.split(".");
    const newObj = { ...obj };
    let current = newObj;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (part) {
        current[part] = { ...current[part] };
        current = current[part];
      }
    }
    const lastPart = parts[parts.length - 1];
    if (lastPart) {
      current[lastPart] = value;
    }
    return newObj;
  };

  const currentProvider = editConfig.provider;
  const modelOptions = getModelOptions(currentProvider);

  // 初始化或当 Provider 变更时检查是否需要进入手动模式
  useEffect(() => {
    const opts = getModelOptions(editConfig.provider);
    if (opts.length > 0 && !opts.includes(editConfig.modelName)) {
      setManualModelMode(true);
    } else {
      setManualModelMode(false);
    }
  }, [editConfig.provider, editConfig.modelName]);

  const fields: ConfigField[] = [
    {
      key: "provider",
      label: "Provider",
      type: "select",
      options: ["openai", "antigravity", "google"],
    },
    { key: "apiKey", label: "API Key", type: "password" },
    { key: "baseUrl", label: "API Base URL", type: "text" },
    {
      key: "modelName",
      label: manualModelMode ? "模型名称 (输入 'reset' 重置)" : "模型名称",
      type: manualModelMode || modelOptions.length === 0 ? "text" : "select",
      options: manualModelMode ? undefined : [...modelOptions, "(Manual Input)"],
    },
    { key: "inputDir", label: "输入目录", type: "text" },
    {
      key: "outputFormat",
      label: "输出格式",
      type: "select",
      options: ["original", "png", "jpg", "webp"],
    },
    { key: "outputDir", label: "输出目录", type: "text" },
    { key: "recursive", label: "递归遍历", type: "boolean" },
    { key: "preserveStructure", label: "保持目录结构", type: "boolean" },
    { key: "concurrency", label: "任务并发数 (1-10)", type: "text" },
    { key: "taskTimeout", label: "单任务超时 (ms)", type: "text" },
    { key: "budgetLimit", label: "成本熔断 (USD, 0=无限制)", type: "text" },
    { key: "debugLog", label: "Debug 日志", type: "boolean" },

    // 高级选项
    { key: "renameRules.enabled", label: "启用自动重命名", type: "boolean", advanced: true },
    { key: "renameRules.suffix", label: "命名后缀", type: "text", advanced: true },
    { key: "renameRules.timestamp", label: "包含时间戳", type: "boolean", advanced: true },
    { key: "prompts.edit", label: "Native 模式 Prompt", type: "text", advanced: true },
    { key: "prompts.detect", label: "Detection 模式 Prompt", type: "text", advanced: true },
  ];

  const visibleFields = fields.filter((f) => !f.advanced || showAdvanced);

  useInput((input, key) => {
    if (isEditing) {
      if (key.escape || key.return) {
        setIsEditing(false);
      }
      return;
    }

    if (key.upArrow) {
      setFocusIndex((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setFocusIndex((i) => Math.min(visibleFields.length - 1, i + 1));
    } else if (key.return) {
      const field = visibleFields[focusIndex];
      if (!field) return;

      const configKey = field.key;
      const val = getNestedValue(editConfig, configKey);

      if (field.type === "boolean") {
        setEditConfig((prev) => setNestedValue(prev, configKey, !val));
      } else if (field.type === "select" && field.options) {
        if (typeof val === "string") {
          const options = field.options;
          let nextIndex = options.indexOf(val);
          if (nextIndex === -1) nextIndex = -1;
          nextIndex = (nextIndex + 1) % options.length;
          const nextVal = options[nextIndex];

          if (nextVal !== undefined) {
            if (configKey === "provider") {
              const nextProvider = nextVal as Config["provider"];
              const prevProvider = val as Config["provider"];

              const updatedSettings = {
                ...editConfig.providerSettings,
                [prevProvider]: {
                  apiKey: editConfig.apiKey,
                  baseUrl: editConfig.baseUrl,
                  modelName: editConfig.modelName,
                },
              };
              const nextSettings = updatedSettings[nextProvider];

              let newModelName = nextSettings.modelName || "";
              const newProviderOptions = getModelOptions(nextProvider);
              if (newProviderOptions.length > 0 && !newProviderOptions.includes(newModelName)) {
                newModelName = newProviderOptions[0] || "";
              }
              // 切换 Provider 时重置手动模式
              setManualModelMode(false);

              setEditConfig((prev) => ({
                ...prev,
                provider: nextProvider,
                apiKey: nextSettings.apiKey || "",
                baseUrl: nextSettings.baseUrl || "",
                modelName: newModelName,
                providerSettings: updatedSettings,
              }));
            } else {
              // 处理模型名称的特殊逻辑
              if (configKey === "modelName" && nextVal === "(Manual Input)") {
                setManualModelMode(true);
                setEditConfig((prev) => setNestedValue(prev, configKey, "")); // 清空以供输入
              } else {
                // 处理数字类型输入
                let finalVal: string | number | boolean = nextVal;
                if (
                  configKey === "concurrency" ||
                  configKey === "taskTimeout" ||
                  configKey === "budgetLimit"
                ) {
                  const numVal = Number.parseFloat(String(nextVal));
                  if (!Number.isNaN(numVal)) {
                    finalVal = numVal;
                  }
                }
                setEditConfig((prev) => setNestedValue(prev, configKey, finalVal));
              }
            }
          }
        }
      } else {
        // Text Input Logic
        if (configKey === "modelName" && manualModelMode) {
          // 如果用户输入了 "reset"，则重置回列表模式
          const currentVal = getNestedValue(editConfig, configKey);
          if (currentVal === "reset") {
            setManualModelMode(false);
            const defaultModel = getModelOptions(editConfig.provider)[0] || "";
            setEditConfig((prev) => setNestedValue(prev, configKey, defaultModel));
            return;
          }
        }
        setIsEditing(true);
      }
    } else if (input === "a") {
      setShowAdvanced(!showAdvanced);
    } else if (input === "r" && showAdvanced) {
      // Reset Prompts
      const defaultPrompt = resetConfig().prompts;
      setEditConfig((prev) => ({
        ...prev,
        prompts: defaultPrompt,
      }));
      setLoginMsg("✅ Prompts 已恢复默认");
    } else if (input === "o") {
      logger.openLogFolder();
      setLoginMsg("📂 已尝试打开日志文件夹");
    } else if ((input === "l" || input === "L") && editConfig.provider === "antigravity") {
      setLoginMsg("⌛️ 正在打开浏览器添加新账号...");
      loginWithAntigravity()
        .then((token) => {
          setAuthState(token);
          // Force re-render of pool list
          setLoginMsg(`✅ 账号 ${token.email} 已添加到算力池!`);
        })
        .catch((err) => {
          setLoginMsg(`❌ 登录失败: ${err.message}`);
        });
    } else if (input === "s") {
      // 保存前确保当前 Provider 的最新配置已同步回档案袋
      const finalConfig = {
        ...editConfig,
        providerSettings: {
          ...editConfig.providerSettings,
          [editConfig.provider]: {
            apiKey: editConfig.apiKey,
            baseUrl: editConfig.baseUrl,
            modelName: editConfig.modelName,
          },
        },
      };
      onSave(finalConfig);
    } else if (key.escape) {
      onCancel();
    } else if (input === "d") {
      // 恢复默认配置 (仅更新当前编辑状态，需按 S 保存)
      setEditConfig(getDefaultConfig());
      setLoginMsg("✅ 已加载默认配置 (请按 S 保存)");
    }
  });

  const currentField = fields[focusIndex];

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>⚙️ 配置设置 (Enter 编辑/切换, S 保存, Esc 取消)</Text>
      </Box>

      {editConfig.provider === "antigravity" && (
        <Box
          borderStyle="round"
          borderColor={tokenPool.getCount() > 0 ? success : danger}
          flexDirection="column"
          marginBottom={1}
          paddingX={1}
          backgroundColor={bg}
        >
          <Box justifyContent="space-between" backgroundColor={bg}>
            <Text bold color={tokenPool.getCount() > 0 ? success : danger} backgroundColor={bg}>
              Antigravity Pool Status: {tokenPool.getCount() > 0 ? "在线" : "未连接"}
            </Text>
            <Text color={accent} backgroundColor={bg}>
              (按 'L' 刷新账号)
            </Text>
          </Box>

          <Box marginTop={1} flexDirection="column" backgroundColor={bg}>
            {tokenPool.getTokens().length === 0 ? (
              <Text color={warning} backgroundColor={bg}>
                暂无关联账号。请按 'L' 登录以构建算力池。
              </Text>
            ) : (
              tokenPool.getTokens().map((t, idx) => (
                <Box
                  key={t.email || idx}
                  flexDirection="row"
                  justifyContent="space-between"
                  backgroundColor={bg}
                >
                  <Text color={fg} backgroundColor={bg}>
                    👤 {t.email || "Unknown User"}
                  </Text>
                  <Text color={dim} backgroundColor={bg}>
                    {" "}
                    | {t.project_id || "N/A"}
                  </Text>
                </Box>
              ))
            )}
          </Box>

          <Box marginTop={1} backgroundColor={bg}>
            <Text color={dim} backgroundColor={bg}>
              {loginMsg}
            </Text>
          </Box>
        </Box>
      )}

      {visibleFields.map((field, index) => {
        const isFocused = index === focusIndex;
        const value = getNestedValue(editConfig, field.key);
        let displayValue = String(value ?? "");

        if (field.key === "provider") {
          if (value === "google") displayValue = "Google Gemini API";
          else if (value === "openai") displayValue = "OpenAI 兼容接口";
          else if (value === "antigravity") displayValue = "Antigravity (集成登录)";
        }

        if (field.key === "apiKey" && value && !isEditing) {
          displayValue = "********";
        }

        // 渲染辅助信息组件
        let hintComponent: React.ReactNode = null;
        if (field.key === "modelName" && isFocused) {
          const isNative = String(value).toLowerCase().includes("image");
          hintComponent = (
            <Box marginLeft={2} flexDirection="column" backgroundColor={bg}>
              <Text
                color={isNative ? (isLight ? "green" : "green") : isLight ? "blue" : "cyan"}
                backgroundColor={bg}
              >
                {isNative
                  ? "🎨 Native Mode: 使用图像生成模型 (如 Gemini Image) 直接重绘修复区域"
                  : "⚡ Detection Mode: 使用视觉模型定位标记 + 本地算法修复 (更快更省钱)"}
              </Text>
              <Text color={isLight ? "black" : "gray"} backgroundColor={bg}>
                {isNative
                  ? "   适合复杂背景 / 高质量需求 / Token 消耗较高"
                  : "   适合纯色/简单背景 / 批量处理 / Token 消耗极低"}
              </Text>
            </Box>
          );
        }

        if (field.key === "baseUrl" && !value) {
          if (editConfig.provider === "openai") {
            displayValue = "(必填，除非使用官方 API)";
          } else if (editConfig.provider === "google") {
            displayValue = "(可选，仅用于 API 代理)";
          } else {
            displayValue = "(默认)";
          }
        }
        if (field.key === "modelName" && !value) {
          displayValue = "(未设置)";
        }

        if (field.type === "text" && !isEditing && !isFocused && displayValue.length > 100) {
          displayValue = `${displayValue.slice(0, 97)}...`;
        }

        let valComponent: React.ReactNode;
        if (field.type === "password") {
          if (isEditing && isFocused) {
            valComponent = (
              <TextInput
                value={String(getNestedValue(editConfig, field.key) ?? "")}
                onChange={(val) => setEditConfig((prev) => setNestedValue(prev, field.key, val))}
                mask="*"
              />
            );
          } else {
            valComponent = (
              <Text color={isLight ? "magenta" : "yellow"}>
                {getNestedValue(editConfig, field.key)
                  ? "*".repeat(String(getNestedValue(editConfig, field.key)).length)
                  : editConfig.provider === "antigravity"
                    ? isLight
                      ? "(通过‘L’键登录自动获取)"
                      : "(通过‘L’键登录自动获取)"
                    : "(未设置)"}
              </Text>
            );
          }
        } else if (field.type === "select") {
          const isProvider = field.key === "provider";
          valComponent = (
            <Box backgroundColor={bg}>
              <Text
                bold={isProvider}
                color={isFocused ? accent : isProvider ? (isLight ? "blue" : "magenta") : undefined}
                backgroundColor={bg}
              >
                {displayValue}
              </Text>
            </Box>
          );
        } else {
          if (isFocused && isEditing) {
            valComponent = (
              <TextInput
                value={String(value ?? "")}
                onChange={(val) => {
                  if (field.key === "concurrency" || field.key === "taskTimeout") {
                    const numVal = Number.parseFloat(val);
                    // 允许输入过程中的临时值，仅处理 NaN
                    const safeVal = Number.isNaN(numVal) ? 0 : numVal;
                    setEditConfig((prev) => setNestedValue(prev, field.key, safeVal));
                  } else if (field.key === "previewCount" || field.key === "budgetLimit") {
                    const numVal = Number.parseFloat(val);
                    setEditConfig((prev) =>
                      setNestedValue(prev, field.key, Number.isNaN(numVal) ? 0 : numVal),
                    );
                  } else {
                    setEditConfig((prev) => setNestedValue(prev, field.key, val));
                  }
                }}
                onSubmit={() => {
                  // 提交时进行最小值钳制
                  if (field.key === "concurrency" || field.key === "taskTimeout") {
                    const currentVal = Number(getNestedValue(editConfig, field.key));
                    const minVal = field.key === "concurrency" ? 1 : 1000;
                    const finalVal = Math.max(currentVal, minVal);
                    setEditConfig((prev) => setNestedValue(prev, field.key, finalVal));
                  }
                  setIsEditing(false);
                }}
              />
            );
          } else {
            valComponent = (
              <Text color={isFocused ? (isLight ? "blue" : "cyan") : undefined}>
                {displayValue}
              </Text>
            );
          }
        }

        // 根据字段类型决定 Label 颜色
        const getFieldLabelColor = () => {
          if (field.advanced) return dim;
          return fg;
        };

        return (
          <Box key={field.key} flexDirection="column">
            <Box>
              <Text bold={isFocused} color={isFocused ? "green" : getFieldLabelColor()}>
                {isFocused ? "▶ " : "  "}
                {field.label}:{" "}
              </Text>
              {valComponent}
            </Box>
            {hintComponent}
          </Box>
        );
      })}

      {/* 底部导航 */}
      <Box
        marginTop={2}
        flexDirection="column"
        borderStyle="round"
        borderColor={isLight ? "black" : "gray"}
        backgroundColor={bg}
      >
        <Box paddingX={1} flexDirection="column" backgroundColor={bg}>
          <Box backgroundColor={bg}>
            <Text color={dim} backgroundColor={bg}>
              快捷键:{" "}
            </Text>
            <Text color={accent} backgroundColor={bg}>
              Esc
            </Text>
            <Text color={dim} backgroundColor={bg}>
              {" "}
              返回 |{" "}
            </Text>
            <Text color={accent} backgroundColor={bg}>
              ↑↓
            </Text>
            <Text color={dim} backgroundColor={bg}>
              {" "}
              导航 |{" "}
            </Text>
            <Text color={accent} backgroundColor={bg}>
              Enter
            </Text>
            <Text color={dim} backgroundColor={bg}>
              {" "}
              确认/编辑
            </Text>
          </Box>
          <Box marginTop={0} backgroundColor={bg}>
            <Text color={accent} backgroundColor={bg}>
              {" "}
              S{" "}
            </Text>
            <Text color={dim} backgroundColor={bg}>
              保存配置 |{" "}
            </Text>
            <Text color={accent} backgroundColor={bg}>
              {" "}
              A{" "}
            </Text>
            <Text color={dim} backgroundColor={bg}>
              {showAdvanced ? "折叠" : "展开"}高级 |{" "}
            </Text>
            <Text color={accent} backgroundColor={bg}>
              {" "}
              D{" "}
            </Text>
            <Text color={dim} backgroundColor={bg}>
              恢复默认
            </Text>
            {editConfig.provider === "antigravity" && (
              <>
                <Text color={dim} backgroundColor={bg}>
                  {" "}
                  |{" "}
                </Text>
                <Text color={accent} backgroundColor={bg}>
                  {" "}
                  L{" "}
                </Text>
                <Text color={dim} backgroundColor={bg}>
                  添加账号/刷新
                </Text>
              </>
            )}
          </Box>
        </Box>
      </Box>
    </Box>
  );
};

const App: React.FC = () => {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>("menu");
  const [config, setConfig] = useState<Config>(() => loadConfig());
  const [status, setStatus] = useState("");
  const processorRef = useRef<BatchProcessor | null>(null);
  const [resumeState, setResumeState] = useState<ResumeState | null>(null);
  const [progress, setProgress] = useState({ current: 0, total: 0, file: "" });
  const [cost, setCost] = useState(0);
  const [thumbnail, setThumbnail] = useState("");
  const [lastStats, setLastStats] = useState<{
    tokens?: { input: number; output: number };
    duration?: number;
  }>({});
  const [error, setError] = useState("");
  const [isGlobalEditing, setIsGlobalEditing] = useState(false);

  // Global Theme State
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const isLight = theme === "light";
  const { bg, fg, dim, accent, warning, danger, success } = getThemeColors(isLight);

  // Change terminal background color using OSC sequences
  useEffect(() => {
    // Check if we can safely use OSC sequences
    const isWindows = process.platform === "win32";
    // Windows Terminal defines WT_SESSION
    const isCompatibleTerminal = !isWindows || process.env.WT_SESSION;

    if (process.stdout.isTTY && isCompatibleTerminal) {
      if (isLight) {
        // Set Default Background to White, Foreground to Black
        process.stdout.write("\x1b]11;#ffffff\x07");
        process.stdout.write("\x1b]10;#000000\x07");
      } else {
        // Reset to typically dark defaults
        process.stdout.write("\x1b]11;#0c0c0c\x07");
        process.stdout.write("\x1b]10;#cccccc\x07");
      }
    }
  }, [isLight]);

  // Sharp Dependency State
  const [sharpMissing, setSharpMissing] = useState(false);
  const [installingSharp, setInstallingSharp] = useState(false);
  const [pkgManager, setPkgManager] = useState<PackageManager>(null);
  const [installLog, setInstallLog] = useState("");
  const [installProgress, setInstallProgress] = useState(0);

  useEffect(() => {
    const deps = DependencyManager.getInstance();
    deps.checkSharp().then((available) => {
      setSharpMissing(!available);
      if (!available) {
        setPkgManager(deps.detectPackageManager());
      }
    });
  }, []);

  const handleInstallSharp = async () => {
    if (installingSharp) return;
    setInstallingSharp(true);
    setInstallProgress(0);
    setInstallLog("Initializing...");
    setStatus("📦 正在安装依赖 sharp...");

    // fake progress simulation
    const timer = setInterval(() => {
      setInstallProgress((p) => {
        if (p >= 90) return p;
        return p + Math.floor(Math.random() * 5);
      });
    }, 500);

    try {
      await DependencyManager.getInstance().installSharp((msg) => {
        setInstallLog(msg);
      });
      clearInterval(timer);
      setInstallProgress(100);
      setSharpMissing(false);
      setStatus("✅ 依赖安装成功！请尽情使用！");
    } catch (err) {
      clearInterval(timer);
      setError(`安装失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setInstallingSharp(false);
    }
  };

  const [reportPath, setReportPath] = useState<string | undefined>();
  const [sessionStats, setSessionStats] = useState<{
    success: number;
    failed: number;
    cost: number;
    tokens: { input: number; output: number };
  }>({ success: 0, failed: 0, cost: 0, tokens: { input: 0, output: 0 } });

  const menuItems: MenuItem[] = [
    { label: "🚀 批量处理", value: "start", icon: "🚀" },
    { label: "🖼️  单文件处理", value: "single", icon: "🖼️" },
    { label: "⚙️  配置设置", value: "settings", icon: "⚙️" },
    { label: " 退出", value: "exit", icon: "🚪" },
  ];

  const handleMenuSelect = async (item: MenuItem) => {
    switch (item.value) {
      case "start":
        setScreen("process");
        await runProcess(false);
        break;
      case "single":
        setScreen("file-selection");
        break;
      case "settings":
        setScreen("config");
        break;
      case "exit":
        exit();
        setTimeout(() => process.exit(0), 100); // 强制退出以避免挂起
        break;
    }
  };

  const executeBatch = async (
    tasksToRun: BatchTask[],
    previewOnly: boolean,
    singleFilePath?: string,
    reportPathFromPrevious?: string,
  ) => {
    try {
      const processor = processorRef.current;
      if (!processor) return;

      const logger = createLogger(config.debugLog);

      setScreen("process");

      const result = await processor.process(tasksToRun, previewOnly, !!singleFilePath);

      setReportPath(result.reportPath);
      setSessionStats({
        success: result.totalSuccess,
        failed: result.totalFailed,
        cost: result.totalCost,
        tokens: result.totalTokens,
      });

      setScreen("done");

      if (result.reportPath) {
        openPath(result.reportPath).catch((err) => {
          logger.warn(`自动打开报告失败: ${err}`);
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setScreen("menu");
    }
  };

  const runProcess = async (previewOnly = false, singleFilePath?: string) => {
    try {
      setError("");
      setStatus("");
      setProgress({ current: 0, total: 0, file: "" });
      setLastStats({});
      setThumbnail("");
      setSessionStats({ success: 0, failed: 0, cost: 0, tokens: { input: 0, output: 0 } });

      const hasToken = tokenPool.getCount() > 0;
      const isAntigravity = config.provider === "antigravity";

      if (!isAntigravity && !config.apiKey) {
        setError("❌ 请先配置 API Key");
        setScreen("menu");
        return;
      }

      if (isAntigravity && !hasToken) {
        setError("❌ 请先登录 Antigravity 账号 (配置页按 'L')");
        setScreen("menu");
        return;
      }

      const logger = createLogger(config.debugLog);
      const provider = createProvider(config);
      const processor = new BatchProcessor({
        config,
        provider,
        logger,
        onProgress: (current, total, file, stats) => {
          setProgress({ current, total, file });
          if (!stats) {
            setLastStats({});
            setThumbnail("");
            return;
          }
          if (stats.lastTaskTokens || stats.lastTaskDuration) {
            setLastStats({ tokens: stats.lastTaskTokens, duration: stats.lastTaskDuration });
          }
          if (stats.lastTaskThumbnail) {
            setThumbnail(renderImageToTerminal(stats.lastTaskThumbnail));
          }
        },
        onCostUpdate: (newCost) => {
          setCost(newCost);
        },
      });
      processorRef.current = processor;

      let tasksToRun: BatchTask[] = [];

      if (singleFilePath) {
        const absPath = normalizePath(singleFilePath, process.cwd());
        if (!absPath) throw new Error("未指定输入路径");
        if (!existsSync(absPath)) throw new Error(`文件不存在: ${absPath}`);

        tasksToRun = [
          {
            absoluteInputPath: absPath,
            absoluteOutputPath: join(
              config.outputDir,
              `${basename(absPath, extname(absPath))}${config.renameRules.suffix}${extname(absPath)}`,
            ),
            relativePath: basename(absPath),
          },
        ];

        await executeBatch(tasksToRun, previewOnly, singleFilePath);
      } else {
        const allTasks = processor.scanTasks();
        const pendingTasks = processor.filterPendingTasks(allTasks);

        // 如果不是预览模式，且检测到有已完成的任务，且有任务被跳过（即 pending < all）
        // 如果 pendingTasks.length === 0 且 allTasks.length > 0，说明所有任务都已完成，也应该提示
        const processedCount = allTasks.length - pendingTasks.length;

        if (!previewOnly && allTasks.length > 0 && processedCount > 0) {
          setResumeState({
            allTasks,
            pendingTasks,
            totalCount: allTasks.length,
            processedCount,
          });
          setScreen("resume-check");
          return;
        }

        if (pendingTasks.length === 0) {
          setError("⚠️ 未找到待处理的图片任务 (可能input为空)");
          setScreen("menu");
          return;
        }

        await executeBatch(pendingTasks, previewOnly);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setScreen("menu");
    }
  };

  useShortcuts({
    screen,
    onExit: exit,
    onNavigate: (target) => {
      // 停止处理器
      if (screen === "process" && target === "menu") {
        processorRef.current?.stop();
      }
      setScreen(target);
    },
    onSelectMenu: (idx) => {
      const item = menuItems[idx];
      if (item) handleMenuSelect(item);
    },
    onOpenReport: () => {
      if (reportPath) openPath(reportPath);
    },
    canOpenReport: !!reportPath,
    isEditing: isGlobalEditing,
  });

  // Global key listener for 'i' install and 't' theme toggle
  useInput((input, key) => {
    const char = input.toLowerCase();
    if (screen === "menu" && sharpMissing && !installingSharp && pkgManager && char === "i") {
      handleInstallSharp();
    }
    if (char === "t" && !isGlobalEditing) {
      setTheme((prev) => (prev === "light" ? "dark" : "light"));
    }
  });

  return (
    <Box flexDirection="column" padding={1} backgroundColor={bg} width="100%">
      {/* 标题区域 - 真正旗舰级 Block Logo */}
      <Box flexDirection="column" marginBottom={1}>
        {/* MARKER */}
        <Box flexDirection="column" backgroundColor={bg}>
          <Text color={isLight ? "black" : "white"} bold backgroundColor={bg}>
            ███╗ ███╗ █████╗ ██████╗ ██╗ ██╗███████╗██████╗
          </Text>
          <Text color={isLight ? "black" : "white"} bold backgroundColor={bg}>
            ████╗ ████║██╔══██╗██╔══██╗██║ ██╔╝██╔════╝██╔══██╗
          </Text>
          <Text color={accent} bold backgroundColor={bg}>
            ██╔████╔██║███████║██████╔╝█████╔╝ █████╗ ██████╔╝
          </Text>
          <Text color={accent} bold backgroundColor={bg}>
            ██║╚██╔╝██║██╔══██║██╔══██╗██╔═██╗ ██╔══╝ ██╔══██╗
          </Text>
          <Text color={accent} bold backgroundColor={bg}>
            ██║ ╚═╝ ██║██║ ██║██║ ██║██║ ██╗███████╗██║ ██║
          </Text>
          <Text color={accent} bold backgroundColor={bg}>
            ╚═╝ ╚═╝╚═╝ ╚═╝╚═╝ ╚═╝╚═╝ ╚═╝╚══════╝╚═╝ ╚═╝
          </Text>
        </Box>

        <Text> </Text>

        {/* CLEANER */}
        <Box flexDirection="column" backgroundColor={bg}>
          <Text color={accent} bold backgroundColor={bg}>
            {" "}
            ██████╗██╗ ███████╗ █████╗ ███╗ ██╗███████╗██████╗{" "}
          </Text>
          <Text color={accent} bold backgroundColor={bg}>
            ██╔════╝██║ ██╔════╝██╔══██╗████╗ ██║██╔════╝██╔══██╗
          </Text>
          <Text color={success} bold backgroundColor={bg}>
            ██║ ██║ █████╗ ███████║██╔██╗ ██║█████╗ ██████╔╝
          </Text>
          <Text color={success} bold backgroundColor={bg}>
            ██║ ██║ ██╔══╝ ██╔══██║██║╚██╗██║██╔══╝ ██╔══██╗
          </Text>
          <Text color={accent} bold backgroundColor={bg}>
            ╚██████╗███████╗███████╗██║ ██║██║ ╚████║███████╗██║ ██║
          </Text>
          <Box backgroundColor={bg}>
            <Text color={accent} bold backgroundColor={bg}>
              {" "}
              ╚═════╝╚══════╝╚══════╝╚═╝ ╚═╝╚═╝ ╚═══╝╚══════╝╚═╝ ╚═╝
            </Text>
            <Text color={fg} bold backgroundColor={bg}>
              {" "}
              v{pkg.version}
            </Text>
          </Box>
        </Box>

        <Text> </Text>
        <Text>
          <Text color={dim} backgroundColor={bg}>
            {" "}
            🧹 Professional AI Image Restorer & Cleaner Tool{" "}
          </Text>
        </Text>
      </Box>
      {/* 当前配置仪表盘 */}
      <Box marginBottom={1} flexDirection="column" backgroundColor={bg}>
        <Text color={dim} backgroundColor={bg}>
          ─────────── 当前配置 ───────────
        </Text>
        <Box marginTop={0} backgroundColor={bg}>
          <Box
            borderStyle="round"
            borderColor={isLight ? "black" : "magenta"}
            marginRight={1}
            backgroundColor={bg}
          >
            <Box paddingX={1} backgroundColor={bg}>
              <Text color={isLight ? "#0066CC" : "magenta"} bold backgroundColor={bg}>
                ⚡ {config.provider.toUpperCase()}
              </Text>
            </Box>
          </Box>
          <Box
            borderStyle="round"
            borderColor={isLight ? "black" : "blue"}
            marginRight={1}
            backgroundColor={bg}
          >
            <Box paddingX={1} backgroundColor={bg}>
              <Text color={isLight ? "#1D1D1F" : "blue"} backgroundColor={bg}>
                🤖 {config.modelName}
              </Text>
            </Box>
          </Box>
          <Box
            borderStyle="round"
            borderColor={
              isLight
                ? "black"
                : config.modelName.toLowerCase().includes("image")
                  ? "green"
                  : "yellow"
            }
            backgroundColor={bg}
          >
            <Box paddingX={1} backgroundColor={bg}>
              <Text
                color={
                  config.modelName.toLowerCase().includes("image")
                    ? isLight
                      ? "#28CD41"
                      : "green"
                    : isLight
                      ? "#FF9500"
                      : "yellow"
                }
                bold
                backgroundColor={bg}
              >
                {config.modelName.toLowerCase().includes("image")
                  ? "🎨 Native Mode"
                  : "⚡ Detection Mode"}
              </Text>
            </Box>
          </Box>
        </Box>
      </Box>

      {/* 错误展示 */}
      {error && (
        <Box marginBottom={1} backgroundColor={bg}>
          <Text color={danger} bold backgroundColor={bg}>
            ✘ {error}
          </Text>
        </Box>
      )}

      {/* 状态栏 */}
      {status && (
        <Box marginBottom={1} paddingX={1} backgroundColor={bg}>
          <Text color={accent} italic backgroundColor={bg}>
            ✨ {status}
          </Text>
        </Box>
      )}

      {/* Sharp 依赖缺失警告 */}
      {screen === "menu" && sharpMissing && (
        <Box
          marginBottom={1}
          borderStyle="round"
          borderColor={isLight ? "blue" : "yellow"}
          flexDirection="column"
          paddingX={1}
          backgroundColor={bg}
        >
          <Text color={accent} bold backgroundColor={bg}>
            ⚠️ 检测到缺少依赖: sharp
          </Text>
          <Text color={fg} backgroundColor={bg}>
            本地模式 (Detection Mode) 需要 sharp 模块。
          </Text>

          {installingSharp ? (
            <Box marginTop={1} flexDirection="column">
              <Text color={isLight ? "blue" : "cyan"}>
                <Spinner type="dots" /> 正在自动安装 sharp...
              </Text>
              <Box marginTop={0}>
                <FakeProgressBar percent={installProgress} isLight={isLight} />
              </Box>
              <Text color={dim} backgroundColor={bg}>
                {installLog}
              </Text>
            </Box>
          ) : pkgManager ? (
            <Box marginTop={1} flexDirection="column">
              <Text>检测到您已安装 {pkgManager}。</Text>
              <Text color="green" bold>
                💡 按 'I' 键自动安装
              </Text>
              {DependencyManager.getInstance().lastError && (
                <Box
                  marginTop={1}
                  borderStyle="single"
                  borderColor={danger}
                  paddingX={1}
                  backgroundColor={bg}
                >
                  <Box backgroundColor={bg}>
                    <Text color="red" backgroundColor={bg}>
                      Debug: {DependencyManager.getInstance().lastError}
                    </Text>
                  </Box>
                </Box>
              )}
              {DependencyManager.getInstance().debugInfo && (
                <Text color={dim} backgroundColor={bg}>
                  Path: {DependencyManager.getInstance().debugInfo}
                </Text>
              )}
            </Box>
          ) : (
            <Box marginTop={1} flexDirection="column">
              <Text color="red">未检测到 Node.js 环境 (npm/bun)。</Text>
              <Text>请先安装 Node.js，然后在同级目录运行: npm install sharp</Text>
            </Box>
          )}
        </Box>
      )}

      {/* 配置缺失警告 */}
      {screen === "menu" &&
        (() => {
          const hasToken = tokenPool.getCount() > 0;
          const needsGoogleKey = !config.apiKey && config.provider === "google";
          const needsOpenAIKey = !config.apiKey && config.provider === "openai";
          const needsAntigravityLogin = config.provider === "antigravity" && !hasToken;

          if (needsGoogleKey || needsOpenAIKey || needsAntigravityLogin) {
            const providerLabel =
              config.provider === "google" ? "Google Gemini API" : config.provider;
            return (
              <Box
                marginBottom={1}
                borderStyle="round"
                borderColor={danger}
                flexDirection="column"
                paddingX={1}
                backgroundColor={bg}
              >
                <Box flexDirection="column" backgroundColor={bg}>
                  <Text color={isLight ? "red" : "red"} bold backgroundColor={bg}>
                    ⚠️ 服务未就绪
                  </Text>
                  {needsAntigravityLogin ? (
                    <Text color="red">请进入 "⚙️ 配置设置" 按 'L' 键登录 Antigravity 账号。</Text>
                  ) : (
                    <>
                      <Text color="red">当前 {providerLabel} 未配置 API Key。</Text>
                      {hasToken ? (
                        <Text color={isLight ? "blue" : "cyan"} bold>
                          💡 检测到您已登录 Antigravity，请在配置中切换 Provider 即可直接使用！
                        </Text>
                      ) : (
                        <Text color="red" backgroundColor={bg}>
                          提示: 您也可以切换 Provider 为 "antigravity" 使用集成登录。
                        </Text>
                      )}
                    </>
                  )}
                </Box>
              </Box>
            );
          }
          return null;
        })()}

      {/* 主内容 */}
      {screen === "menu" && (
        <Box flexDirection="column" backgroundColor={bg}>
          <Box marginBottom={1} backgroundColor={bg}>
            <Text bold backgroundColor={bg}>
              请选择操作:
            </Text>
          </Box>
          <Box backgroundColor={bg} paddingX={1}>
            <SelectInput items={menuItems} onSelect={handleMenuSelect} />
          </Box>
        </Box>
      )}

      {screen === "config" && (
        <ConfigScreen
          config={config}
          onSave={(newConfig) => {
            saveConfig(newConfig);
            setConfig(newConfig);
            setStatus("✅ 配置已保存");
            setScreen("menu");
            setIsGlobalEditing(false); // 重置状态
          }}
          onCancel={() => {
            setScreen("menu");
            setIsGlobalEditing(false); // 重置状态
          }}
          onEditingChange={setIsGlobalEditing}
          logger={createLogger(config.debugLog)}
          isLight={isLight}
        />
      )}

      {screen === "resume-check" && resumeState && (
        <ResumeCheckScreen
          state={resumeState}
          isLight={isLight}
          onResume={() => {
            // 继续：只运行 pendingTasks
            executeBatch(resumeState.pendingTasks, false);
          }}
          onRestart={() => {
            // 重新开始：先清除进度，然后运行 allTasks
            clearProgress();
            // 注意：这里需要更新 processor 内部的 progress 状态，最简单的方法是重新实例化或者调用 clearProgress 方法
            // 这里的 clearProgress() 是全局工具函数，会重置 progress.json
            // 我们还需要重置 processor 实例的 progress 对象
            processorRef.current?.clearProgress();
            executeBatch(resumeState.allTasks, false);
          }}
          onCancel={() => {
            setScreen("menu");
            setResumeState(null);
          }}
        />
      )}

      {screen === "file-selection" && (
        <FileSelectionScreen
          inputDir={config.inputDir}
          onSelect={(path) => {
            setScreen("process");
            runProcess(false, path);
            setIsGlobalEditing(false); // 重置状态
          }}
          onCancel={() => {
            setScreen("menu");
            setIsGlobalEditing(false); // 重置状态
          }}
          onEditingChange={setIsGlobalEditing}
          isLight={isLight}
        />
      )}

      {screen === "process" && (
        <Box flexDirection="column">
          <Box>
            <Text color="green">
              <Spinner type="dots" />
            </Text>
            <Text> 正在处理 ... (按 'Q' 终止)</Text>
          </Box>
          {progress.total > 0 && (
            <Box marginTop={1} flexDirection="column">
              <Text>
                进度: {progress.current}/{progress.total}
              </Text>
              <Text color={dim} backgroundColor={bg}>
                当前: {progress.file}
              </Text>

              {thumbnail && (
                <Box
                  borderStyle="single"
                  borderColor={isLight ? "black" : "gray"}
                  paddingX={1}
                  marginBottom={0}
                  backgroundColor={bg}
                >
                  <Box backgroundColor={bg}>
                    <Text backgroundColor={bg}>{thumbnail}</Text>
                  </Box>
                </Box>
              )}

              {lastStats.tokens && (
                <Text color={isLight ? "blue" : "cyan"}>
                  ⚡ 上个任务: {lastStats.tokens.input + lastStats.tokens.output} tokens (
                  {lastStats.tokens.input} 输入 / {lastStats.tokens.output} 输出)
                </Text>
              )}
              {lastStats.duration !== undefined && (
                <Text color={dim} backgroundColor={bg}>
                  ⏱️ 耗时: {formatDuration(lastStats.duration)}
                </Text>
              )}
              <Box marginTop={1}>
                <Text color={isLight ? "magenta" : "yellow"}>💰 累计成本: ${cost.toFixed(4)}</Text>
                {config.budgetLimit > 0 && (
                  <Text color={dim} backgroundColor={bg}>
                    {" "}
                    (上限: ${config.budgetLimit})
                  </Text>
                )}
              </Box>
            </Box>
          )}
        </Box>
      )}

      {screen === "done" && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={isLight ? "black" : success}
          backgroundColor={bg}
        >
          <Box paddingX={2} flexDirection="column" backgroundColor={bg}>
            <Text color={success} bold backgroundColor={bg}>
              ✅ 批处理任务完成!
            </Text>
            <Box flexDirection="column" marginTop={1} backgroundColor={bg}>
              <Text color={fg} backgroundColor={bg}>
                • 成功:{" "}
                <Text color={success} backgroundColor={bg}>
                  {sessionStats.success}
                </Text>{" "}
                个
              </Text>
              <Text color={fg} backgroundColor={bg}>
                • 失败:{" "}
                <Text color={danger} backgroundColor={bg}>
                  {sessionStats.failed}
                </Text>{" "}
                个
              </Text>
              <Text color={fg} backgroundColor={bg}>
                • 耗能:{" "}
                <Text color={accent} backgroundColor={bg}>
                  {sessionStats.tokens.input + sessionStats.tokens.output}
                </Text>{" "}
                Tokens
              </Text>
              <Text color={fg} backgroundColor={bg}>
                • 本次成本:{" "}
                <Text color={warning} backgroundColor={bg}>
                  ${sessionStats.cost.toFixed(4)}
                </Text>
              </Text>
            </Box>
            <Box marginTop={1} flexDirection="column" backgroundColor={bg}>
              <Text color={dim} backgroundColor={bg}>
                按{" "}
              </Text>
              <Box backgroundColor={bg}>
                <Text bold color={accent} backgroundColor={bg}>
                  {" "}
                  Enter{" "}
                </Text>
                <Text color={dim} backgroundColor={bg}>
                  {" "}
                  键打开 HTML 处理报告
                </Text>
              </Box>
              <Text color={dim} backgroundColor={bg}>
                按 Esc 返回主菜单
              </Text>
            </Box>
          </Box>
        </Box>
      )}

      {/* 底部导航 */}
      <Box
        marginTop={1}
        borderStyle="round"
        borderColor={isLight ? "black" : "gray"}
        backgroundColor={bg}
      >
        <Box paddingX={1} backgroundColor={bg}>
          <Text color={dim} backgroundColor={bg}>
            快捷键:{" "}
          </Text>
          <Text color={accent} backgroundColor={bg}>
            ↑↓
          </Text>
          <Text color={dim} backgroundColor={bg}>
            {" "}
            导航 |{" "}
          </Text>
          <Text color={accent} backgroundColor={bg}>
            Enter
          </Text>
          <Text color={dim} backgroundColor={bg}>
            {" "}
            选择 |{" "}
          </Text>
          <Text color={accent} backgroundColor={bg}>
            Q
          </Text>
          <Text color={dim} backgroundColor={bg}>
            {" "}
            退出
          </Text>
        </Box>
      </Box>
    </Box>
  );
};

// 启动应用
render(<App />);

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"; // 新增导入
import { dirname, extname, join } from "node:path"; // 新增导入
import { Box, Text, render, useApp, useInput } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input"; // 新增导入
import type React from "react";
import { useEffect, useState } from "react";
import { createProvider } from "./lib/ai";
import { loadToken, loginWithAntigravity } from "./lib/antigravity/auth";
import { AntigravityProvider, type QuotaStatus } from "./lib/antigravity/provider";
function isAntigravityProvider(provider: unknown): provider is AntigravityProvider {
  return provider instanceof AntigravityProvider;
}
import { BatchProcessor } from "./lib/batch-processor";
import { type Config, loadConfig, resetConfig, saveConfig } from "./lib/config-manager";
import { createLogger } from "./lib/logger";
import { formatDuration, renderImageToTerminal } from "./lib/utils";

// ============ 依赖检测 ============
let sharpAvailable = true;
try {
  require("sharp");
} catch {
  sharpAvailable = false;
}

type Screen = "menu" | "config" | "process" | "done";

interface MenuItem {
  label: string;
  value: string;
  icon?: string;
}

const App: React.FC = () => {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>("menu");
  const [config, setConfig] = useState<Config>(() => loadConfig());
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState({ current: 0, total: 0, file: "" });
  const [cost, setCost] = useState(0);
  const [thumbnail, setThumbnail] = useState("");
  const [lastStats, setLastStats] = useState<{
    tokens?: { input: number; output: number };
    duration?: number;
  }>({});
  const [error, setError] = useState("");

  const menuItems: MenuItem[] = [
    { label: "🚀 开始处理", value: "start", icon: "🚀" },
    { label: "⚙️  配置设置", value: "settings", icon: "⚙️" },
    { label: "🔄 恢复默认配置", value: "reset", icon: "🔄" },
    { label: "🚪 退出", value: "exit", icon: "🚪" },
  ];

  const handleMenuSelect = async (item: MenuItem) => {
    switch (item.value) {
      case "start":
        setScreen("process");
        await runProcess(false);
        break;
      case "settings":
        setScreen("config");
        break;
      case "reset": {
        const newConfig = resetConfig();
        setConfig(newConfig);
        setStatus("✅ 已恢复默认配置");
        break;
      }
      case "exit":
        exit();
        break;
    }
  };

  const runProcess = async (previewOnly: boolean) => {
    try {
      const hasToken = !!loadToken();
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
          if (stats?.lastTaskTokens || stats?.lastTaskDuration) {
            setLastStats({ tokens: stats.lastTaskTokens, duration: stats.lastTaskDuration });
          }
          if (stats?.lastTaskThumbnail) {
            setThumbnail(renderImageToTerminal(stats.lastTaskThumbnail));
          }
        },
        onCostUpdate: (newCost) => {
          setCost(newCost);
        },
      });

      const allTasks = processor.scanTasks();
      const pendingTasks = processor.filterPendingTasks(allTasks);

      setStatus(`找到 ${allTasks.length} 个文件，待处理 ${pendingTasks.length} 个`);

      await processor.process(pendingTasks, previewOnly);

      setScreen("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setScreen("menu");
    }
  };

  useInput((input, key) => {
    const lowerInput = input.toLowerCase();

    if (key.escape || lowerInput === "q") {
      if (screen !== "menu") {
        setScreen("menu");
      } else {
        exit();
      }
    }

    // 快捷键支持 (主菜单)
    if (screen === "menu") {
      if (lowerInput === "s" && menuItems[0]) handleMenuSelect(menuItems[0]); // Start
      if (lowerInput === "c" && menuItems[1]) handleMenuSelect(menuItems[1]); // Config/Settings
      if (lowerInput === "r" && menuItems[2]) handleMenuSelect(menuItems[2]); // Reset
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      {/* 标题 */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          ╔══════════════════════════════════════╗
        </Text>
      </Box>
      <Box>
        <Text bold color="cyan">
          ║ 🧹 智能标记清除工具 v1.0 ║
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          ╚══════════════════════════════════════╝
        </Text>
      </Box>

      {/* Provider 信息 */}
      <Box marginBottom={1}>
        <Text dimColor>
          Provider: {config.provider} | Model: {config.modelName}
        </Text>
      </Box>

      {/* 错误展示 */}
      {error && (
        <Box marginBottom={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}

      {/* 状态栏 */}
      {status && (
        <Box marginBottom={1}>
          <Text color="yellow">{status}</Text>
        </Box>
      )}

      {/* Sharp 依赖缺失警告 */}
      {screen === "menu" && !sharpAvailable && (
        <Box
          marginBottom={1}
          borderStyle="round"
          borderColor="yellow"
          flexDirection="column"
          paddingX={1}
        >
          <Text color="yellow" bold>
            ⚠️ 缺少依赖: sharp
          </Text>
          <Text color="yellow">本地图像修复功能需要 sharp 模块。请运行:</Text>
          <Text color="cyan" bold>
            {" "}
            bun add sharp
          </Text>
        </Box>
      )}

      {/* 配置缺失警告 */}
      {screen === "menu" &&
        (() => {
          const hasToken = !!loadToken();
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
                borderColor="red"
                flexDirection="column"
                paddingX={1}
              >
                <Text color="red" bold>
                  ⚠️ 服务未就绪
                </Text>
                {needsAntigravityLogin ? (
                  <Text color="red">请进入 "⚙️ 配置设置" 按 'L' 键登录 Antigravity 账号。</Text>
                ) : (
                  <>
                    <Text color="red">当前 {providerLabel} 未配置 API Key。</Text>
                    {hasToken ? (
                      <Text color="cyan" bold>
                        💡 检测到您已登录 Antigravity，请在配置中切换 Provider 即可直接使用！
                      </Text>
                    ) : (
                      <Text color="red" dimColor>
                        提示: 您也可以切换 Provider 为 "antigravity" 使用集成登录。
                      </Text>
                    )}
                  </>
                )}
              </Box>
            );
          }
          return null;
        })()}

      {/* 主内容 */}
      {screen === "menu" && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold>请选择操作:</Text>
          </Box>
          <SelectInput items={menuItems} onSelect={handleMenuSelect} />
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
          }}
          onCancel={() => setScreen("menu")}
          logger={createLogger(config.debugLog)}
        />
      )}

      {screen === "process" && (
        <Box flexDirection="column">
          <Box>
            <Text color="green">
              <Spinner type="dots" />
            </Text>
            <Text> 正在处理 ...</Text>
          </Box>
          {progress.total > 0 && (
            <Box marginTop={1} flexDirection="column">
              <Text>
                进度: {progress.current}/{progress.total}
              </Text>
              <Text dimColor>当前: {progress.file}</Text>

              {thumbnail && (
                <Box borderStyle="single" borderColor="gray" paddingX={1} marginBottom={0}>
                  <Text>{thumbnail}</Text>
                </Box>
              )}

              {lastStats.tokens && (
                <Text color="cyan">
                  ⚡ 上个任务: {lastStats.tokens.input + lastStats.tokens.output} tokens (
                  {lastStats.tokens.input} In / {lastStats.tokens.output} Out)
                </Text>
              )}
              {lastStats.duration !== undefined && (
                <Text color="gray">⏱️ 耗时: {formatDuration(lastStats.duration)}</Text>
              )}
              <Box marginTop={1}>
                <Text color="yellow">💰 累计成本: ${cost.toFixed(4)}</Text>
                {config.budgetLimit > 0 && <Text dimColor> (上限: ${config.budgetLimit})</Text>}
              </Box>
            </Box>
          )}
        </Box>
      )}

      {screen === "done" && (
        <Box flexDirection="column">
          <Text color="green" bold>
            ✅ 处理完成!
          </Text>
          <Text>已处理: {progress.current} 个文件</Text>
          <Text color="yellow">💰 总成本: ${cost.toFixed(4)}</Text>
          <Box marginTop={1}>
            <Text dimColor>按 Esc 返回菜单</Text>
          </Box>
        </Box>
      )}

      {/* 底部导航 */}
      <Box marginTop={1}>
        <Text dimColor>按 ↑↓ 导航 | 按 Enter 选择 | 按 Q 退出</Text>
      </Box>
    </Box>
  );
};

// 简化的配置界面

interface ConfigScreenProps {
  config: Config;
  onSave: (config: Config) => void;
  onCancel: () => void;
  logger: ReturnType<typeof createLogger>;
}

interface ConfigField {
  key: string; // 改为 string 以支持嵌套键
  label: string;
  type: "text" | "password" | "boolean" | "select";
  options?: string[];
  advanced?: boolean;
}

const ConfigScreen: React.FC<ConfigScreenProps> = ({ config, onSave, onCancel, logger }) => {
  const [editConfig, setEditConfig] = useState(config);
  const [focusIndex, setFocusIndex] = useState(0);
  const [isEditing, setIsEditing] = useState(false);
  const [authState, setAuthState] = useState(loadToken());
  const [loginMsg, setLoginMsg] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [quota, setQuota] = useState<QuotaStatus | null>(null);

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

  const getModelOptions = (provider: string) => {
    if (provider === "antigravity") {
      return [
        "gemini-3-pro-image", // Native
        "gemini-3-flash", // Detection
        "gemini-3-pro-high", // Detection
        "gemini-3-pro-low", // Detection
        "claude-sonnet-4-5", // Detection
      ];
    }
    if (provider === "google") {
      return [
        "gemini-2.5-flash-image", // Native
        "gemini-2.0-flash-exp", // Native
        "gemini-1.5-pro", // Detection
        "gemini-1.5-flash", // Detection
      ];
    }
    return [];
  };

  const currentProvider = editConfig.provider;
  const modelOptions = getModelOptions(currentProvider);

  const fields: ConfigField[] = [
    {
      key: "provider",
      label: "Provider",
      type: "select",
      options: ["openai", "antigravity", "google"],
    },
    { key: "apiKey", label: "API Key", type: "password" },
    { key: "baseUrl", label: "代理地址", type: "text" },
    {
      key: "modelName",
      label: "模型名称",
      type: modelOptions.length > 0 ? "select" : "text",
      options: modelOptions.length > 0 ? modelOptions : undefined,
    },
    { key: "inputDir", label: "输入目录", type: "text" },
    { key: "outputDir", label: "输出目录", type: "text" },
    { key: "recursive", label: "递归遍历", type: "boolean" },
    { key: "budgetLimit", label: "成本熔断 (USD)", type: "text" },
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

              setEditConfig((prev) => ({
                ...prev,
                provider: nextProvider,
                apiKey: nextSettings.apiKey || "",
                baseUrl: nextSettings.baseUrl || "",
                modelName: newModelName,
                providerSettings: updatedSettings,
              }));
            } else {
              setEditConfig((prev) => setNestedValue(prev, configKey, nextVal));
            }
          }
        }
      } else {
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
    } else if (input === "l" && editConfig.provider === "antigravity") {
      setLoginMsg("⌛️ 正在打开浏览器登录 Auth...");
      loginWithAntigravity()
        .then((token) => {
          setAuthState(token);
          setLoginMsg(`✅ 登录成功! (${token.email})`);
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
          borderColor={authState ? "green" : "red"}
          flexDirection="column"
          marginBottom={1}
          paddingX={1}
        >
          <Text bold color={authState ? "green" : "red"}>
            Antigravity Auth Status: {authState ? "已登录" : "未登录"}
          </Text>
          {authState?.email && <Text>Email: {authState.email}</Text>}
          {authState?.project_id && <Text>Project: {authState.project_id}</Text>}

          {quota && (
            <Box flexDirection="column" marginTop={1}>
              {quota.tier && (
                <Text bold color="magenta">
                  Current Tier: {quota.tier}
                </Text>
              )}
              {quota.quotaTotal && (
                <Box flexDirection="column">
                  <Text bold color="yellow">
                    Quota Status:
                  </Text>
                  <Text>
                    • API Quota: {quota.quotaRemaining} / {quota.quotaTotal}
                  </Text>
                  {quota.promptCreditsTotal && (
                    <Text>
                      • Prompt Credits: {quota.promptCreditsRemaining} / {quota.promptCreditsTotal}
                    </Text>
                  )}
                </Box>
              )}
            </Box>
          )}

          <Box marginTop={1}>
            <Text>
              {loginMsg || (authState ? "按 'L' 重新登录" : "👉 按 'L' 键进行浏览器登录")}
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
          else if (value === "openai") displayValue = "OpenAI (需 GPT-4o)";
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
            <Box marginLeft={2}>
              <Text color={isNative ? "green" : "cyan"} dimColor>
                {isNative ? "🎨 Native Mode (原生生成)" : "⚡ Detection Mode (视觉检测)"}
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

        if (field.type === "text" && !isEditing && displayValue.length > 40) {
          displayValue = `${displayValue.slice(0, 37)}...`;
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
              <Text color="yellow">
                {getNestedValue(editConfig, field.key)
                  ? "*".repeat(String(getNestedValue(editConfig, field.key)).length)
                  : editConfig.provider === "antigravity"
                    ? "(通过‘L’键登录自动获取)"
                    : "(未设置)"}
              </Text>
            );
          }
        } else if (field.type === "select") {
          const isProvider = field.key === "provider";
          valComponent = (
            <Text bold={isProvider} color={isProvider ? "magenta" : isFocused ? "cyan" : undefined}>
              {displayValue}
            </Text>
          );
        } else {
          if (isFocused && isEditing) {
            valComponent = (
              <TextInput
                value={String(value ?? "")}
                onChange={(val) => {
                  if (field.key === "previewCount" || field.key === "budgetLimit") {
                    setEditConfig((prev) =>
                      setNestedValue(prev, field.key, Number.parseFloat(val) || 0),
                    );
                  } else {
                    setEditConfig((prev) => setNestedValue(prev, field.key, val));
                  }
                }}
                onSubmit={() => setIsEditing(false)}
              />
            );
          } else {
            valComponent = <Text color={isFocused ? "cyan" : undefined}>{displayValue}</Text>;
          }
        }

        return (
          <Box key={field.key} flexDirection="column">
            <Box>
              <Text color={isFocused ? "cyan" : undefined}>
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
      <Box marginTop={2} flexDirection="column">
        <Text dimColor>按 Esc 返回 | 按 ↑↓ 导航 | 按 Enter 确认/编辑</Text>
        <Box>
          <Text dimColor>按 </Text>
          <Text bold color="cyan">
            S
          </Text>
          <Text dimColor> 保存 | 按 </Text>
          <Text bold color="cyan">
            A
          </Text>
          <Text dimColor> {showAdvanced ? "折叠" : "展开"}高级设置 | 按 </Text>
          <Text bold color="cyan">
            O
          </Text>
          <Text dimColor> 打开日志文件夹</Text>
        </Box>
        {showAdvanced && (
          <Text dimColor>
            按{" "}
            <Text bold color="red">
              R
            </Text>{" "}
            恢复所有 Prompt 为默认值
          </Text>
        )}
        {editConfig.provider === "antigravity" && (
          <Text dimColor>
            按{" "}
            <Text bold color="cyan">
              L
            </Text>{" "}
            登录 Antigravity 账号
          </Text>
        )}
      </Box>
    </Box>
  );
};

// 启动应用
render(<App />);

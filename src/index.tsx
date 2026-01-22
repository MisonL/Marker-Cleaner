import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"; // 新增导入
import { basename, dirname, extname, join } from "node:path"; // 新增导入
import { fileURLToPath } from "node:url";
import { Box, Text, render, useApp, useInput } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input"; // 新增导入
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { createProvider } from "./lib/ai";
import { loadToken, loginWithAntigravity } from "./lib/antigravity/auth";
import { AntigravityProvider, type QuotaStatus } from "./lib/antigravity/provider";
function isAntigravityProvider(provider: unknown): provider is AntigravityProvider {
  return provider instanceof AntigravityProvider;
}
import { BatchProcessor } from "./lib/batch-processor";
import { type Config, loadConfig, resetConfig, saveConfig } from "./lib/config-manager";
import { createLogger } from "./lib/logger";
import type { BatchTask } from "./lib/types";
import { formatDuration, openPath, renderImageToTerminal } from "./lib/utils";

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
  const { screen, onExit, onNavigate, onSelectMenu, onOpenReport, canOpenReport, isEditing } = params;

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
    if (screen === "done" && lowerInput === "o" && canOpenReport) {
      onOpenReport?.();
    }
  });
}

// ============ 依赖检测 ============
let sharpAvailable = true;
try {
  require("sharp");
} catch {
  sharpAvailable = false;
}

type Screen = "menu" | "config" | "process" | "done" | "file-selection";

// ============ 单文件选择界面 ============

interface FileSelectionScreenProps {
  inputDir: string;
  onSelect: (path: string) => void;
  onCancel: () => void;
  onEditingChange?: (isEditing: boolean) => void;
}

const FileSelectionScreen: React.FC<FileSelectionScreenProps> = ({
  inputDir,
  onSelect,
  onCancel,
  onEditingChange,
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

  return (
    <Box flexDirection="column" paddingX={2}>
      <Text bold color="cyan">
        🖼️ 单文件处理
      </Text>
      <Box marginBottom={1}>
        <Text dimColor>请选择文件或输入路径 (Esc 返回)</Text>
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
            let finalPath = file.trim();

            if (finalPath.startsWith("file://")) {
              try {
                finalPath = fileURLToPath(finalPath);
              } catch {
                // Ignore invalid URLs, keep as is
              }
            }

            const isAbsolute =
              finalPath.startsWith("/") || // Unix absolute
              finalPath.match(/^[a-zA-Z]:/) || // Windows drive
              finalPath.startsWith("\\\\"); // Windows UNC

            const fullPath = isAbsolute ? finalPath : join(inputDir, finalPath);
            onSelect(fullPath);
          }
        }}
        onCancel={onCancel}
        onEditingChange={onEditingChange}
      />
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
}) {
  const [mode, setMode] = useState<"list" | "manual">("list");
  const [manualPath, setManualPath] = useState(props.value);

  useEffect(() => {
    props.onEditingChange?.(mode === "manual");
  }, [mode]);

  useInput((input, key) => {
    if (key.tab) {
      setMode((prev) => (prev === "list" ? "manual" : "list"));
    }
    if (key.escape) {
      props.onCancel();
    }
  });

  return (
    <Box flexDirection="column">
      {mode === "list" ? (
        <SelectInput
          items={props.files.map((f) => ({ label: f, value: f }))}
          onSelect={(item) => props.onSelect(item.value)}
        />
      ) : (
        <Box flexDirection="column">
          <Box>
            <Text>📁 手动输入路径: </Text>
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
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>支持相对路径 (如 ./test.jpg) 或绝对路径</Text>
            <Text dimColor>按 Enter 确认，按 Tab 切换回列表</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}

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
  const processorRef = useRef<BatchProcessor | null>(null);
  const [progress, setProgress] = useState({ current: 0, total: 0, file: "" });
  const [cost, setCost] = useState(0);
  const [thumbnail, setThumbnail] = useState("");
  const [lastStats, setLastStats] = useState<{
    tokens?: { input: number; output: number };
    duration?: number;
  }>({});
  const [error, setError] = useState("");
  const [isGlobalEditing, setIsGlobalEditing] = useState(false);

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
    { label: "🔄 恢复默认配置", value: "reset", icon: "🔄" },
    { label: "🚪 退出", value: "exit", icon: "🚪" },
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
      case "reset": {
        const newConfig = resetConfig();
        setConfig(newConfig);
        setStatus("✅ 已恢复默认配置");
        break;
      }
      case "exit":
        exit();
        setTimeout(() => process.exit(0), 100); // 强制退出以避免挂起
        break;
    }
  };

  const runProcess = async (previewOnly: boolean, singleFilePath?: string) => {
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

      let pendingTasks: BatchTask[] = [];
      if (singleFilePath) {
        let normalizedPath = singleFilePath.trim();
        if (normalizedPath.startsWith("file://")) {
          try {
            normalizedPath = fileURLToPath(normalizedPath);
          } catch {
            // Ignore invalid URLs
          }
        }

        const isAbsolute =
          normalizedPath.startsWith("/") ||
          (process.platform === "win32" &&
            (normalizedPath.includes(":") || normalizedPath.startsWith("\\\\")));
        const absPath = isAbsolute ? normalizedPath : join(process.cwd(), normalizedPath);

        if (!existsSync(absPath)) throw new Error(`文件不存在: ${absPath}`);

        pendingTasks = [
          {
            absoluteInputPath: absPath,
            absoluteOutputPath: join(
              config.outputDir,
              `${basename(absPath, extname(absPath))}${config.renameRules.suffix}${extname(absPath)}`,
            ),
            relativePath: basename(absPath),
          },
        ];
      } else {
        const allTasks = processor.scanTasks();
        pendingTasks = processor.filterPendingTasks(allTasks);
      }

      setStatus(
        singleFilePath
          ? `正在处理单个文件: ${basename(singleFilePath)}`
          : `找到 ${pendingTasks.length} 个任务`,
      );

      const result = await processor.process(pendingTasks, previewOnly, !!singleFilePath);

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

  return (
    <Box flexDirection="column" padding={1}>
      {/* 标题 */}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="cyan"
        paddingX={3}
        paddingY={0}
        marginBottom={1}
        alignSelf="flex-start"
      >
        <Text bold color="cyan">
          🧹 MARKER CLEANER
        </Text>
        <Text dimColor>Professional AI Image Restorer v1.0.0</Text>
      </Box>

      {/* Provider 信息 - 状态胶囊 */}
      <Box marginBottom={1}>
        <Box borderStyle="single" borderColor="gray" paddingX={1} marginRight={2}>
          <Text color="magenta">Provider</Text>
          <Text> {config.provider}</Text>
        </Box>
        <Box borderStyle="single" borderColor="gray" paddingX={1}>
          <Text color="blue">Model</Text>
          <Text> {config.modelName}</Text>
        </Box>
      </Box>

      {/* 错误展示 */}
      {error && (
        <Box marginBottom={1}>
          <Text color="red" bold>
            ✘ {error}
          </Text>
        </Box>
      )}

      {/* 状态栏 */}
      {status && (
        <Box marginBottom={1} paddingX={1}>
          <Text color="yellow" italic>
            ✨ {status}
          </Text>
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
            setIsGlobalEditing(false); // 重置状态
          }}
          onCancel={() => {
            setScreen("menu");
            setIsGlobalEditing(false); // 重置状态
          }}
          onEditingChange={setIsGlobalEditing}
          logger={createLogger(config.debugLog)}
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
        <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={2}>
          <Text color="green" bold>
            ✅ 批处理任务完成!
          </Text>
          <Box flexDirection="column" marginTop={1}>
            <Text>
              • 成功: <Text color="green">{sessionStats.success}</Text> 个
            </Text>
            <Text>
              • 失败: <Text color="red">{sessionStats.failed}</Text> 个
            </Text>
            <Text>
              • 耗能:{" "}
              <Text color="cyan">{sessionStats.tokens.input + sessionStats.tokens.output}</Text>{" "}
              Tokens
            </Text>
            <Text>
              • 本次成本: <Text color="yellow">${sessionStats.cost.toFixed(4)}</Text>
            </Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>按 </Text>
            <Box>
              <Text bold color="magenta">
                {" "}
                O{" "}
              </Text>
              <Text dimColor> 键打开 HTML 处理报告</Text>
            </Box>
            <Text dimColor>按 Esc 返回主菜单</Text>
          </Box>
        </Box>
      )}

      {/* 底部导航 */}
      <Box marginTop={1} borderStyle="classic" borderColor="gray" paddingX={1}>
        <Text dimColor>快捷键: </Text>
        <Text color="cyan">↑↓</Text>
        <Text dimColor> 导航 | </Text>
        <Text color="cyan">Enter</Text>
        <Text dimColor> 选择 | </Text>
        <Text color="cyan">Q</Text>
        <Text dimColor> 退出</Text>
      </Box>
    </Box>
  );
};

// 简化的配置界面

interface ConfigScreenProps {
  config: Config;
  onSave: (config: Config) => void;
  onCancel: () => void;
  onEditingChange?: (isEditing: boolean) => void;
  logger: ReturnType<typeof createLogger>;
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
  return ["(Manual Input)"];
};

const ConfigScreen: React.FC<ConfigScreenProps> = ({
  config,
  onSave,
  onCancel,
  onEditingChange,
  logger,
}) => {
  const [editConfig, setEditConfig] = useState<Config>({ ...config });
  const [isEditing, setIsEditing] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const [authState, setAuthState] = useState(loadToken());
  const [loginMsg, setLoginMsg] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const [manualModelMode, setManualModelMode] = useState(false);

  useEffect(() => {
    onEditingChange?.(isEditing);
  }, [isEditing]);

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
    { key: "baseUrl", label: "代理地址", type: "text" },
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
      <Box
        marginTop={2}
        flexDirection="column"
        borderStyle="classic"
        borderColor="gray"
        paddingX={1}
      >
        <Box>
          <Text dimColor>快捷键: </Text>
          <Text color="cyan">Esc</Text>
          <Text dimColor> 返回 | </Text>
          <Text color="cyan">↑↓</Text>
          <Text dimColor> 导航 | </Text>
          <Text color="cyan">Enter</Text>
          <Text dimColor> 确认/编辑</Text>
        </Box>
        <Box marginTop={1}>
          <Text color="magenta"> S </Text>
          <Text dimColor>保存配置 | </Text>
          <Text color="magenta"> A </Text>
          <Text dimColor>{showAdvanced ? "折叠" : "展开"}高级 | </Text>
          <Text color="magenta"> O </Text>
          <Text dimColor>日志目录</Text>
          {editConfig.provider === "antigravity" && (
            <>
              <Text dimColor> | </Text>
              <Text color="magenta"> L </Text>
              <Text dimColor>账号登录</Text>
            </>
          )}
        </Box>
      </Box>
    </Box>
  );
};

// 启动应用
render(<App />);

import React, { useState, useEffect } from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input"; // Added import
import Spinner from "ink-spinner";
import { loadConfig, saveConfig, resetConfig, type Config } from "./lib/config-manager";
import { createProvider } from "./lib/ai";
import { BatchProcessor } from "./lib/batch-processor";
import { createLogger } from "./lib/logger";
import { loginWithAntigravity, loadToken } from "./lib/antigravity/auth";

type Screen = "menu" | "config" | "process" | "preview" | "done";

interface MenuItem {
  label: string;
  value: string;
}

const App: React.FC = () => {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>("menu");
  const [config, setConfig] = useState<Config>(() => loadConfig());
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState({ current: 0, total: 0, file: "" });
  const [cost, setCost] = useState(0);
  const [error, setError] = useState("");

  const menuItems: MenuItem[] = [
    { label: "🚀 开始处理", value: "start" },
    { label: "👁️  预览模式 (处理前 " + config.previewCount + " 张)", value: "preview" },
    { label: "⚙️  配置设置", value: "config" },
    { label: "🔄 恢复默认配置", value: "reset" },
    { label: "🚪 退出", value: "exit" },
  ];

  const handleMenuSelect = async (item: MenuItem) => {
    switch (item.value) {
      case "start":
        setScreen("process");
        await runProcess(false);
        break;
      case "preview":
        setScreen("preview");
        await runProcess(true);
        break;
      case "config":
        setScreen("config");
        break;
      case "reset":
        const newConfig = resetConfig();
        setConfig(newConfig);
        setStatus("✅ 已恢复默认配置");
        break;
      case "exit":
        exit();
        break;
    }
  };

  const runProcess = async (previewOnly: boolean) => {
    try {
      if (!config.apiKey) {
        setError("❌ 请先配置 API Key");
        setScreen("menu");
        return;
      }

      const logger = createLogger(config.debugLog);
      const provider = createProvider(config);
      const processor = new BatchProcessor({
        config,
        provider,
        logger,
        onProgress: (current, total, file) => {
          setProgress({ current, total, file });
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
    if (key.escape) {
      if (screen !== "menu") {
        setScreen("menu");
      } else {
        exit();
      }
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          ╔══════════════════════════════════════╗
        </Text>
      </Box>
      <Box>
        <Text bold color="cyan">
          ║   🧹 智能标记清除工具 v1.0           ║
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          ╚══════════════════════════════════════╝
        </Text>
      </Box>

      {/* Provider Info */}
      <Box marginBottom={1}>
        <Text dimColor>
          Provider: {config.provider} | Model: {config.modelName}
        </Text>
      </Box>

      {/* Error Display */}
      {error && (
        <Box marginBottom={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}

      {/* Status */}
      {status && (
        <Box marginBottom={1}>
          <Text color="yellow">{status}</Text>
        </Box>
      )}

      {/* Missing API Key Warning */}
      {!config.apiKey && screen === "menu" && (
        <Box marginBottom={1} borderStyle="round" borderColor="red" flexDirection="column" paddingX={1}>
          <Text color="red" bold>⚠️  未检测到 API Key</Text>
          <Text color="red">请选择 "⚙️  配置设置" 并输入您的 Gemini API Key 才能开始使用。</Text>
        </Box>
      )}

      {/* Main Content */}
      {screen === "menu" && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold>
              请选择操作:
            </Text>
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
        />
      )}

      {(screen === "process" || screen === "preview") && (
        <Box flexDirection="column">
          <Box>
            <Text color="green">
              <Spinner type="dots" />
            </Text>
            <Text> 正在处理 {screen === "preview" ? "(预览模式)" : ""}...</Text>
          </Box>
          {progress.total > 0 && (
            <Box marginTop={1} flexDirection="column">
              <Text>
                进度: {progress.current}/{progress.total}
              </Text>
              <Text dimColor>当前: {progress.file}</Text>
              <Text color="yellow">💰 累计成本: ${cost.toFixed(4)}</Text>
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

      {/* Footer */}
      <Box marginTop={2}>
        <Text dimColor>按 Esc 返回 | 按 ↑↓ 导航 | 按 Enter 确认</Text>
      </Box>
    </Box>
  );
};

// 简化的配置界面

interface ConfigScreenProps {
  config: Config;
  onSave: (config: Config) => void;
  onCancel: () => void;
}

const ConfigScreen: React.FC<ConfigScreenProps> = ({ config, onSave, onCancel }) => {
  const [editConfig, setEditConfig] = useState(config);
  const [focusIndex, setFocusIndex] = useState(0);
  const [isEditing, setIsEditing] = useState(false);
  const [authState, setAuthState] = useState(loadToken());
  const [loginMsg, setLoginMsg] = useState("");

  const fields: { key: keyof Config; label: string; type: "text" | "password" | "boolean" | "select"; options?: string[] }[] = [
    { key: "apiKey", label: "API Key", type: "password" },
    { key: "baseUrl", label: "Base URL", type: "text" },
    { key: "provider", label: "Provider", type: "select", options: ["google", "openai", "antigravity"] },
    { key: "modelName", label: "模型名称", type: "text" },
    { key: "inputDir", label: "输入目录", type: "text" },
    { key: "outputDir", label: "输出目录", type: "text" },
    { key: "recursive", label: "递归遍历", type: "boolean" },
    { key: "previewCount", label: "预览数量", type: "text" },
    { key: "debugLog", label: "Debug 日志", type: "boolean" },
  ];

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
      setFocusIndex((i) => Math.min(fields.length - 1, i + 1));
    } else if (key.return) {
        // Toggle boolean or select, or enter edit mode for text
        const field = fields[focusIndex];
        if (!field) return;

        if (field.type === "boolean") {
            setEditConfig(prev => ({ 
              ...prev, 
              [field.key]: !prev[field.key as keyof Config] 
            }));
        } else if (field.type === "select" && field.options) {
             const currentVal = editConfig[field.key as keyof Config] as string;
             const nextIndex = (field.options.indexOf(currentVal) + 1) % field.options.length;
             setEditConfig(prev => ({ 
               ...prev, 
               [field.key]: field.options![nextIndex] 
             }));
        } else {
            setIsEditing(true);
        }
    } else if (input === "l" && editConfig.provider === "antigravity") {
        setLoginMsg("⌛️ 正在打开浏览器登录 Auth...");
        loginWithAntigravity()
            .then(token => {
                setAuthState(token);
                setLoginMsg("✅ 登录成功! (" + token.email + ")");
            })
            .catch(err => {
                setLoginMsg("❌ 登录失败: " + err.message);
            });
    } else if (input === "s") {
      onSave(editConfig);
    } else if (key.escape) {
      onCancel();
    }
  });
  
  const currentField = fields[focusIndex];

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>
          ⚙️ 配置设置 (Enter 编辑/切换, S 保存, Esc 取消)
        </Text>
      </Box>
      
      {editConfig.provider === "antigravity" && (
          <Box borderStyle="round" borderColor={authState ? "green" : "red"} flexDirection="column" marginBottom={1} paddingX={1}>
            <Text bold color={authState ? "green" : "red"}>
                Antigravity Auth Status: {authState ? "已登录" : "未登录"}
            </Text>
            {authState?.email && <Text>Email: {authState.email}</Text>}
            {authState?.project_id && <Text>Project: {authState.project_id}</Text>}
            <Box marginTop={1}>
                <Text>{loginMsg || (authState ? "按 'L' 重新登录" : "👉 按 'L' 键进行浏览器登录")}</Text>
            </Box>
          </Box>
      )}

      {fields.map((field, index) => {
        const isFocused = index === focusIndex;
        const value = editConfig[field.key];
        let displayValue = String(value);
        if (field.key === "apiKey" && value && !isEditing) {
            displayValue = "********";
        }
        if (field.key === "baseUrl" && !value) {
            displayValue = "(默认)";
        }
        
        return (
            <Box key={field.key}>
              <Text color={isFocused ? "cyan" : undefined}>
                {isFocused ? "▶ " : "  "}
                {field.label}:{" "}
              </Text>
              
              {isFocused && isEditing ? (
                  <TextInput 
                    value={String(value ?? "")}
                    onChange={(val) => {
                         if (field.key === "previewCount") {
                             setEditConfig(prev => ({...prev, [field.key]: parseInt(val) || 0 }));
                         } else {
                             setEditConfig(prev => ({...prev, [field.key]: val }));
                         }
                    }}
                    onSubmit={() => setIsEditing(false)}
                  />
              ) : (
                  <Text color={isFocused ? "cyan" : undefined}>{displayValue}</Text>
              )}
            </Box>
        );
      })}
    </Box>
  );
};

// 启动应用
render(<App />);

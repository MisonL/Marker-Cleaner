import React, { useState, useEffect } from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import { loadConfig, saveConfig, resetConfig, type Config } from "./lib/config-manager";
import { createProvider } from "./lib/ai";
import { BatchProcessor } from "./lib/batch-processor";
import { createLogger } from "./lib/logger";

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

  const fields = [
    { key: "inputDir", label: "输入目录", value: editConfig.inputDir },
    { key: "outputDir", label: "输出目录", value: editConfig.outputDir },
    { key: "apiKey", label: "API Key", value: editConfig.apiKey ? "****" : "(未设置)" },
    { key: "baseUrl", label: "Base URL", value: editConfig.baseUrl ?? "(默认)" },
    { key: "modelName", label: "模型名称", value: editConfig.modelName },
    { key: "provider", label: "Provider", value: editConfig.provider },
    { key: "recursive", label: "递归遍历", value: editConfig.recursive ? "是" : "否" },
    { key: "previewCount", label: "预览数量", value: String(editConfig.previewCount) },
    { key: "debugLog", label: "Debug 日志", value: editConfig.debugLog ? "是" : "否" },
  ];

  useInput((input, key) => {
    if (key.upArrow) {
      setFocusIndex((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setFocusIndex((i) => Math.min(fields.length - 1, i + 1));
    } else if (input === "s") {
      onSave(editConfig);
    } else if (key.escape) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>
          ⚙️ 配置设置 (按 S 保存, Esc 取消)
        </Text>
      </Box>
      {fields.map((field, index) => (
        <Box key={field.key}>
          <Text color={index === focusIndex ? "cyan" : undefined}>
            {index === focusIndex ? "▶ " : "  "}
            {field.label}: {field.value}
          </Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor>提示: 完整配置请编辑 marker-cleaner.json 文件</Text>
      </Box>
    </Box>
  );
};

// 启动应用
render(<App />);

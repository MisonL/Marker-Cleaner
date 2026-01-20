# 🧹 智能标记清除工具

基于 **Google Gemini AI** 的智能图像标记清除工具。自动识别并移除监控截图中的手动标记（红色/橙色矩形框、箭头等），保持背景完整。

## ✨ 特性

- 🤖 **AI 驱动**: 使用 Gemini 2.5 Flash 智能识别标记
- 🖼️ **双模式支持**:
  - **Pro 模式**: AI 原生图像编辑（效果最佳）
  - **Nano 模式**: AI 检测坐标 + 本地修复
- 📁 **批量处理**: 递归遍历目录，保持原目录结构
- 💾 **断点续传**: 中断后可恢复进度
- 💰 **成本追踪**: 实时显示 Token 消耗与费用估算
- ⚙️ **高度可配置**: Prompt 可编辑、定价可自定义
- 🖥️ **现代 TUI**: 优雅的终端交互界面

## 🚀 快速开始

### 1. 安装依赖

```bash
bun install
```

### 2. 配置 API Key

首次运行会自动生成 `marker-cleaner.json` 配置文件。编辑它填入你的 API Key：

```json
{
  "apiKey": "YOUR_GEMINI_API_KEY",
  "modelName": "gemini-2.5-flash-image"
}
```

### 3. 准备图片

将待处理图片放入 `./input` 目录。

### 4. 启动

```bash
bun start
```

## ⚙️ 配置说明

| 配置项              | 默认值                   | 说明                      |
| ------------------- | ------------------------ | ------------------------- |
| `inputDir`          | `./input`                | 输入目录                  |
| `outputDir`         | `./output`               | 输出目录                  |
| `recursive`         | `true`                   | 递归遍历子目录            |
| `preserveStructure` | `true`                   | 输出保持原目录结构        |
| `provider`          | `google`                 | AI 提供商 (google/openai) |
| `modelName`         | `gemini-2.5-flash-image` | 模型名称                  |
| `baseUrl`           | -                        | 自定义 API 端点           |
| `previewCount`      | `3`                      | 预览模式处理数量          |
| `debugLog`          | `false`                  | 输出调试日志到文件        |

## 📝 自定义 Prompt

在 `marker-cleaner.json` 中编辑：

```json
{
  "prompts": {
    "edit": "请移除图中所有红色矩形标记框...",
    "detect": "请识别标记框并返回 JSON 坐标..."
  }
}
```

## 📊 成本估算

| 模型             | 输入 (百万 Token) | 输出 (百万 Token) | 图片生成  |
| ---------------- | ----------------- | ----------------- | --------- |
| Gemini 2.5 Flash | $0.15             | $0.60             | $0.039/张 |

## 📜 License

MIT

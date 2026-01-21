<div align="center">

# 🧹 Marker Cleaner | 智能图像标记清除工具

![Version](https://img.shields.io/badge/version-1.0.0-blue.svg?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)
![Stack](https://img.shields.io/badge/tech-Bun%20%7C%20React%20Ink%20%7C%20TypeScript-black.svg?style=flat-square)

Marker Cleaner 是一款基于 **AI 驱动** 的专业图像修复工具，旨在自动识别并移除图片中的人工标记（如矩形框、箭头、涂鸦等），同时完美还原背景细节。

工具现已全面支持 **Google Gemini 2.5 多模态** 与 **Antigravity Pro** 协议，为您提供工业级的图像处理能力。

</div>

---

## ✨ 核心特性

### 🤖 强大的 AI 引擎

- **Google Gemini 2.5 Flash Image**: 官方原生支持多模态生成，性价比极高。
- **Antigravity Gemini 3 Pro Image**: 专有协议支持顶级画质，通过 Sandbox 环境实现稳定调用。

### 🛠️ 双重工作模式

| 模式               | 描述                      | 适用场景           | 优势                   |
| :----------------- | :------------------------ | :----------------- | :--------------------- |
| **Native 模式**    | AI 原生重绘 (Nano Banana) | 复杂背景、重度遮挡 | 完美修复细节，无痕还原 |
| **Detection 模式** | 坐标检测 + 本地修复       | 纯色背景、简单标记 | 速度极快，成本极低     |

### ⚡️ 极致性能与体验

- **CLI 交互界面**: 基于 React Ink 构建的现代化终端 UI。
- **批量处理**: 递归遍历目录，自动保持原文件结构。
- **断点续传**: 处理中断后，下次运行可无缝恢复进度。
- **成本透明**: 实时计算 Token 消耗与预估费用。

---

## 🚀 快速开始

### 1. 环境准备

本项目基座基于全链路 **Bun** 架构，请确保已安装 Bun。

```bash
# 安装依赖
bun install
```

### 2. 启动应用

```bash
bun start
```

首次运行会自动生成配置文件，您只需按需编辑即可。

- **macOS**: `~/.marker-cleaner/marker-cleaner.json`
- **Linux**: `~/.config/marker-cleaner/marker-cleaner.json`
- **Windows**: `%APPDATA%/marker-cleaner/marker-cleaner.json`

---

## ⚙️ 配置指南

为了获得最佳体验，请根据您的需求选择合适的 Provider。

### 方案 A：追求极速性价比

使用 Google 官方渠道，配合最新的 Gemini 2.5 Flash 模型。

> [!IMPORTANT]
> **注意**：Google 官方 API 要求账号等级达到 **Tier 1** 才能调用 Image 生成模型。如果不满足此条件，请使用 **Antigravity** 渠道。

```json
{
  "provider": "google",
  "providerSettings": {
    "google": {
      "apiKey": "YOUR_GOOGLE_API_KEY",
      "modelName": "gemini-2.5-flash-image" // 自动开启多模态生成
    }
  }
}
```

### 方案 B：追求极致画质与能力 (Antigravity - 推荐)

使用内部 Antigravity 渠道，支持 Gemini 3 全系列顶级模型。

```json
{
  "provider": "antigravity",
  "providerSettings": {
    "antigravity": {
      "apiKey": "YOUR_ANTIGRAVITY_TOKEN",
      "modelName": "gemini-3-pro-image"
    }
  }
}
```

**Antigravity 可用模型清单**:
| 模型 ID | 特性 | 适用场景 |
| :--- | :--- | :--- |
| **`gemini-3-pro-image`** | 🎨 原生图像生成 | **Native 模式** (Inpainting) 首选 |
| **`gemini-3-flash`** | ⚡ 最快响应速度 | **Detection 模式** (Detection) 首选 |
| **`gemini-3-pro-high`** | 🧠 最高推理智力 | 复杂语义理解 |
| **`gemini-3-pro-low`** | ⚖️ 性能平衡版 | 通用任务 |
| `claude-sonnet-4-5` | 🤖 Claude 旗舰 | 备选推理引擎 |
| `gpt-oss-120b-medium` | 🌐 开源大模型 | 备选方案 |

### 常用全局配置

| 配置项         | 默认值     | 说明                 |
| :------------- | :--------- | :------------------- |
| `inputDir`     | `./input`  | 待处理图片目录       |
| `outputDir`    | `./output` | 结果输出目录         |
| `recursive`    | `true`     | 是否递归子目录       |
| `previewCount` | `3`        | 预览模式下的图片数量 |
| `debugLog`     | `false`    | 是否开启调试日志     |

---

## 🏗️ 技术架构

- **Runtime**: [Bun](https://bun.sh) - 极速 JavaScript 运行时
- **UI Framework**: [React Ink](https://github.com/vadimdemedes/ink) - 终端即组件
- **Image Processing**: [Sharp](https://sharp.pixelplumbing.com) - 高性能图片处理
- **Configuration**: [Zod](https://zod.dev) - 严格的类型校验
- **AI Integration**:
  - `@google/generative-ai` (Official SDK)
  - Custom REST Client (Antigravity Protocol)

## 📝 自定义 Prompt

您可以完全控制 AI 的行为指令。在配置文件中找到 `prompts` 字段：

```json
{
  "prompts": {
    "edit": "请移除图中所有红色矩形标记框，并修复被遮挡的文字...",
    "detect": "请识别图中所有红色标记框的坐标，格式为..."
  }
}
```

## 📜 License

MIT License © 2026 Marker Cleaner Team

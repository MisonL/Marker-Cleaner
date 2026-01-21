# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] - 2026-01-21

### ✨ 核心功能 (Core Features)

- **多模态 AI 引擎**:
  - **Native 模式**: 集成 Gemini 3 / Gemini 2.5 原生图像重绘能力，支持复杂背景的完美无痕修复。
  - **Detection 模式**: 结合 AI 视觉定位与本地像素算法，实现纯色背景下的极速低成本修复。
  - **多 Provider 支持**: 完整接入 Google Gemini、OpenAI及 Antigravity 渠道。

- **生产力工具集**:
  - **CLI 交互界面 (TUI)**: 基于 React Ink 的现代化终端，支持快捷键、输出格式选择 (png/jpg/webp) 及目录结构保持。
  - **智能批量处理**: 支持多线程并发 (Concurrency 1-10)，内置断点续传、智能重命名及冲突处理。
  - **工业级鲁棒性**: 全链路指数退避重试、120s 任务超时熔断、Sefety Block 优雅降级。

- **可视化与成本**:
  - **HTML 报告**: 自动生成包含处理前后对比图的交互式报告（单文件内联，无需外部依赖）。
  - **成本追踪**: 实时计算并显示 Token 消耗与预估费用，支持设置预算熔断 (Budget Limit)。

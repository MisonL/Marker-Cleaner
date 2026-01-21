# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] - 2026-01-21

### Added

- 多 AI Provider 支持：Google Gemini、OpenAI、Antigravity
- Pro 模式：AI 原生图像编辑
- Nano 模式：AI 检测坐标 + 本地修复
- 批量处理：递归遍历目录，保持原目录结构
- 断点续传：中断后可恢复进度
- 成本追踪：实时显示 Token 消耗与费用估算
- 跨平台配置目录支持 (XDG/APPDATA/homedir)
- 自动迁移旧版配置文件

### Security

- 配置文件存储迁移至用户隐藏目录
- 旧配置文件迁移后自动清理

### Developer

- 添加 Biome 代码格式化和 lint 配置
- 添加单元测试 (utils.ts, config-manager.ts)
- 添加 Bun 跨平台打包脚本

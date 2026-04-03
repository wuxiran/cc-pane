# Thinking Guides (CC-Panes)

> 在编码前扩展思维，避免"没想到"的 bug。

---

## Available Guides

| Guide | Purpose | When to Use |
|-------|---------|-------------|
| [Cross-Layer Thinking](./cross-layer-thinking-guide.md) | 跨层数据流思考 | 功能跨越 Rust-TS 边界 |
| [Code Reuse Thinking](./code-reuse-thinking-guide.md) | 识别模式、减少重复 | 写类似代码时 |
| [Tauri Architecture](./tauri-architecture-guide.md) | Tauri 特定架构决策 | 新功能涉及 IPC 设计 |

---

## Quick Triggers

### When to Think About Cross-Layer Issues

- [ ] 功能涉及 3+ 层（Component, Store, Service, Command, Rust Service, Repository）
- [ ] Rust 和 TS 之间传递复杂数据结构
- [ ] 新增或修改 Tauri 命令

### When to Think About Code Reuse

- [ ] 写类似代码时先搜索已有实现
- [ ] 同一模式出现 3+ 次
- [ ] 新增工具函数前搜索 `web/utils/` 和 `src-tauri/src/utils/`

### When to Think About Tauri Architecture

- [ ] 新功能需要新的 IPC 命令
- [ ] 考虑前端还是后端处理某个逻辑
- [ ] 涉及文件系统、进程、系统 API

---

## Core Principle

> 30 分钟的思考省下 3 小时的调试。

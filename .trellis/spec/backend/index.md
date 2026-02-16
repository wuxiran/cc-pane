# Backend Development Guidelines (CC-Panes)

> Rust + Tauri 2 + SQLite (rusqlite)

---

## Overview

CC-Panes 后端是一个 Tauri 2 应用，使用 Rust 实现业务逻辑，通过 IPC 暴露给前端。数据存储使用 SQLite。

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Rust 项目结构和模块组织 | Done |
| [Error Handling](./error-handling.md) | AppResult<T> 和 AppError 模式 | Done |
| [Database Guidelines](./database-guidelines.md) | SQLite/rusqlite 使用规范 | Done |
| [Service Layer](./service-layer.md) | 服务层设计和 State 注入 | Done |
| [Quality Guidelines](./quality-guidelines.md) | Clippy + rustfmt 规范 | Done |

---

## Quick Reference

- **错误处理**: `AppResult<T>` = `Result<T, AppError>`
- **State 注入**: `State<'_, Arc<XxxService>>` 获取服务
- **分层**: Command → Service → Repository
- **测试**: 内存 SQLite (`:memory:`)
- **序列化**: `serde(rename_all = "camelCase")` 对齐 TS

---

**Language**: Documentation in Chinese, code comments in English.

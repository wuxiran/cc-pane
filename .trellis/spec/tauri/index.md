# Tauri Development Guidelines (CC-Panes)

> Tauri 2 IPC, Rust-TS Bridge, Event System

---

## Overview

CC-Panes 使用 Tauri 2 框架，前端 React 通过 IPC (`invoke`) 调用后端 Rust 命令。本目录定义跨层通信的规范。

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [IPC Design](./ipc-design.md) | Tauri 命令设计规范 | Done |
| [Bridge Patterns](./bridge-patterns.md) | Rust-TS 桥接模式 | Done |
| [Security Checklist](./security-checklist.md) | IPC 安全检查清单 | Done |

---

## Quick Reference

- **数据流**: Component → Store → Service (`invoke`) → Command → Service → Repository
- **命名**: Rust `snake_case` → serde → TS `camelCase`
- **错误**: Rust `AppResult<T>` → `String` → TS `catch`
- **类型对齐**: `src-tauri/src/models/*.rs` ↔ `web/types/index.ts`

---

## Critical Rule

修改以下任何文件时，必须同时检查对应层：

| 修改文件 | 必须检查 |
|----------|---------|
| `commands/*.rs` | `services/*.ts` (invoke 调用) |
| `models/*.rs` | `types/index.ts` (TS 接口) |
| `services/*.ts` | `commands/*.rs` (Rust 命令) |
| `types/index.ts` | `models/*.rs` (Rust 结构体) |

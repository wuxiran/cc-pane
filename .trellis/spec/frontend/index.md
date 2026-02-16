# Frontend Development Guidelines (CC-Panes)

> React 19 + TypeScript + Zustand + Tailwind CSS 4 + shadcn/ui

---

## Overview

CC-Panes 前端运行在 Tauri 2 的 WebView 中，通过 `invoke()` 与 Rust 后端通信。所有 IPC 调用必须经过 Service 层封装。

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | 模块组织和文件布局 | Done |
| [Component Guidelines](./component-guidelines.md) | 组件模式、Props、组合 | Done |
| [Hook Guidelines](./hook-guidelines.md) | 自定义 Hooks、数据获取模式 | Done |
| [State Management](./state-management.md) | Zustand + Immer 状态管理 | Done |
| [Quality Guidelines](./quality-guidelines.md) | 代码标准、禁止模式 | Done |
| [Type Safety](./type-safety.md) | 类型模式、Rust-TS 对齐 | Done |

---

## Quick Reference

- **组件**: 函数组件 + Hooks，不使用 class 组件
- **状态**: Zustand 5 + Immer middleware
- **样式**: Tailwind CSS 4 + shadcn/ui + Radix UI
- **路径别名**: `@/` → `src/`
- **测试**: Co-located (`*.test.ts` 与实现同目录)
- **IPC**: 组件 → Store → Service (invoke) → Tauri IPC

---

**Language**: Documentation in Chinese, code comments in English.

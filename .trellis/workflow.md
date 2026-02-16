# CC-Panes Development Workflow

> Tauri 2 全栈开发工作流

---

## Project Overview

CC-Panes 是一个基于 Tauri 2 的跨平台桌面应用，用于管理多个 Claude Code 实例的分屏布局。

**Tech Stack**: React 19 + TypeScript + Zustand | Rust + Tauri 2 + SQLite

**Architecture**: Component → Store → Service (invoke) → Command → Service → Repository → SQLite

---

## Available Commands

| Command | Purpose |
|---------|---------|
| `/ccbook:start` | 启动开发会话，加载上下文 |
| `/ccbook:onboard` | 新人引导 |
| `/ccbook:check-frontend` | 前端代码检查 |
| `/ccbook:check-backend` | 后端代码检查 |
| `/ccbook:check-tauri-bridge` | Rust-TS 桥接一致性检查 |
| `/ccbook:check-cross-layer` | 跨层检查 |
| `/ccbook:finish-work` | 完成工作，提交前检查清单 |
| `/ccbook:parallel` | 多 Agent 并行编排 |

---

## Development Flow

### For New Features (tauri-fullstack)

1. **Plan**: 使用 plan agent 分析需求，确定涉及哪些层
2. **Implement**: 按 7 步流程实现
   - Model → Repository → Service(Rust) → Command → Service(TS) → Store → Component
3. **Check**: 运行 `/ccbook:check-tauri-bridge` + `/ccbook:check-cross-layer`
4. **Finish**: 运行 `/ccbook:finish-work` 完成检查清单

### For Frontend-Only Changes

1. 修改 Components / Stores / Services
2. `npx tsc --noEmit` 类型检查
3. `/ccbook:check-frontend`

### For Backend-Only Changes

1. 修改 Commands / Services / Repository
2. `cargo clippy --workspace -- -D warnings`
3. `/ccbook:check-backend`

---

## Spec Directory

```
.trellis/spec/
├── frontend/    # React 19 + TypeScript + Zustand standards
├── backend/     # Rust + Tauri 2 + SQLite standards
├── tauri/       # IPC design, Rust-TS bridge patterns
└── guides/      # Cross-layer thinking, code reuse, architecture
```

---

## Key Principles

1. **类型一致性**: Rust struct ↔ TS interface 必须同步
2. **Service 层隔离**: 组件不直接 invoke，通过 Service 层
3. **不可变更新**: Zustand + Immer 模式
4. **错误显式处理**: Rust 用 AppResult<T>，TS 用 try/catch
5. **小文件**: <800 行，小函数: <50 行

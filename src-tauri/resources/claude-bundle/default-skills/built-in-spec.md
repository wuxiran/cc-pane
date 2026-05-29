---
name: ccpanes-built-in-spec
description: CC-Panes 内置 Spec + Todo 双向绑定 — 说明 Spec 文件结构、specService 前端 API、Tauri 命令边界。**不是** MCP 工作流（cc-panes 没暴露 MCP create_spec），AI 主要走 Tauri 前端 service 或让用户在 UI 操作。
trigger: |
  - 用户问 CC-Panes 的 Spec/Todo 怎么用、文件结构、如何创建/激活/归档
  - 用户问 sync_spec_tasks、handle_terminal_exit_spec 这些机制是什么
  不触发：
  - 想走通用 spec-workflow MCP（需求/设计/任务/实现四段式） → 用 ccpanes:spec
  - 想引导写一份独立 spec 文档 → 用 /ccpanes:openspec（方法论）
---

# spec — CC-Panes 内置 Spec + Todo 工作流（说明型）

CC-Panes 在每个项目下维护一份 **Spec 文档 + Todo 任务**双向绑定的轻量规格系统。本 skill 说明它如何工作、哪些操作走哪个层（MCP / Tauri 前端 service / UI）。

> **关键边界**：cc-panes 目前**没有**暴露 MCP 工具来创建 Spec。AI 想创建/激活/归档 Spec，要么 (a) 走前端 specService（Claude 用 invoke 调 Tauri），要么 (b) 让用户在 CC-Panes UI 里点。下方"操作路径"表格说清楚每个动作在哪层。

---

## 何时用 / 何时不用

**用**：
- 用户问 Spec/Todo 怎么用、目录在哪、Active 状态机
- 想知道 sync_spec_tasks / handle_terminal_exit_spec 这些机制
- 想用 CC-Panes 已有的 Spec 来跟踪一个不大不小的功能（Proposal/Design/Tasks/Log 四段足够）

**不用**：
- 想走通用 spec-workflow 四段式（requirements/design/tasks/implementation）→ `ccpanes:spec`（外部 MCP）
- 只想要方法论引导，不依赖 CC-Panes 后端 → `/ccpanes:openspec`
- 单文件小修复 / 不值得开 spec

`ccpanes:built-in-spec`（本 skill） ≠ `ccpanes:spec`（外部 spec-workflow MCP） ≠ `ccpanes:openspec`（方法论 + Claude/Codex 自由写）。

---

## 系统概述

### 三层模型

- **Spec**：一份 Markdown 规格文档，存在 `<project>/.ccpanes/specs/<slug>.spec.md`
- **Todo**：与 Spec 绑定的任务跟踪项（含子任务）
- **双向同步**：Spec 文件 `## Tasks` 段 ↔ Todo 子任务（通过 Tauri 命令 `sync_spec_tasks`）

### 状态机

```
Draft  ──激活──▶  Active  ──归档──▶  Archived
  ▲                 │
  └─── 回退 ────────┘   （Archived 不能回退，见下方"必读 gotcha"）
```

- **Draft**：起草中
- **Active**：进行中。**同一项目同一时间只能有一个 Active Spec** —— 激活新 Spec 会自动 deactivate 当前 Active（**无二次确认**，操作前先列出当前 Active 提示用户）
- **Archived**：完成后归档，文件移到 `archived/<日期前缀>_<原名>.spec.md`

### 文件存储

```
<project>/.ccpanes/specs/
├── <slug>.spec.md          # Draft / Active
└── archived/
    └── 20260315_<slug>.spec.md  # Archived
```

目录由 CC-Panes 内置 Spec 服务自动创建和维护。**AI 不要手动 mkdir 或直接改内部索引文件。**

---

## 操作路径表（关键）

| 操作 | MCP 工具 | Tauri 命令 / 前端 service | UI |
|------|----------|---------------------------|------|
| 创建 Spec | ❌ 不存在 | `specService.create({projectPath, title, tasks?})` → Tauri `create_spec` | ✅ |
| 列出 Spec | ❌ 不存在 | `specService.list(projectPath, status?)` | ✅ |
| 读 Spec 内容 | ❌ 不存在 | `specService.getContent(projectPath, specId)` | ✅ |
| 保存 Spec 内容 | ❌ 不存在 | `specService.saveContent(...)`（skill 旧版漏了这个）| ✅ |
| 更新 Spec 状态 | ❌ 不存在 | `specService.update(specId, {status})` | ✅ |
| 删除 Spec | ❌ 不存在 | `specService.delete(projectPath, specId)`（**best-effort，不是事务** —— 见 gotcha）| ✅ |
| 同步 Tasks | ❌ 不存在 | `specService.syncTasks(projectPath, specId)` → Tauri `sync_spec_tasks` | 自动（终端退出触发） |
| 终端退出自动日志 | ❌ N/A（被动机制）| CC-Panes 终端退出事件自动触发 | 自动 |
| 查询 Todo | ✅ `mcp__ccpanes__query_todos`（**没有 todoType 字段**）| `todoService.query(...)` | ✅ |
| 创建 Todo | ✅ `mcp__ccpanes__create_todo`（**没有 todoType 字段** —— 只创建普通 Todo，**不会**创建 Spec 文件）| `todoService.create(...)` | ✅ |
| 更新 Todo | ✅ `mcp__ccpanes__update_todo`（`id/status/title/priority/description`，**没有 `completed` 字段**）| `todoService.update(...)` | ✅ |

**重点纠错（针对 skill 旧版本）**：

- ❌ `ccpanes.create_todo({todoType: "spec"})` —— **MCP 不支持此参数**，调了也只会创建普通 Todo，**不会**创建 Spec 文件 / DB 记录。Spec 创建必须走 `specService.create` 或让用户在 UI 操作。
- ❌ `ccpanes.query_todos({todoType: "spec"})` —— 同理，MCP 没有此 filter。
- ❌ `ccpanes.update_todo({completed: true})` —— 真实字段是 `status`，没有 `completed`。

---

## Spec 文件结构

每份 Spec 由 4 个核心段组成：

```markdown
# Spec: 功能标题
> Status: draft | Created: 2026-03-15

## Proposal
变更动机和目标 — 为什么、解决什么、预期效果。

## Design
技术方案 — 架构、组件、接口。

### Affected Files
- `src/xxx.ts` [ADDED]
- `src/yyy.ts` [MODIFIED]
- `src/zzz.ts` [DELETED]

## Tasks (auto-synced from CC-Panes)
<!-- 此段由 CC-Panes 自动同步，请通过 Todo 面板编辑 -->
- [ ] 任务 1
- [x] 任务 2（已完成）
- [ ] 任务 3

## Log
### 2026-03-15
- ADDED `src/foo.ts`
- MODIFIED `src/bar.ts`
```

| 段 | 用途 | 编辑方式 |
|----|------|----------|
| **Proposal** | 动机 / 目标 | 手动编写 |
| **Design** | 技术方案 / 影响文件 | 手动编写 |
| **Tasks** | 任务 checkbox | **自动同步**（通过 Todo 面板编辑） |
| **Log** | 变更日志 | 终端退出时**自动追加** + 手动补充 |

---

## 必读 gotcha

1. **Markdown 头部的 `> Status: draft` 不是事实来源**。`update_spec` 改 DB 状态但**不**同步文件头。读状态应该查 DB / 通过 `specService.list`，别看文件头。
2. **Archived → Draft 不可回退**：后端 `update_spec` 注释允许 Active→Draft，但 Archived 改 Draft **不会**把文件从 `archived/` 移回，后续路径解析会错。**别让 Spec 从 Archived 状态回退。**
3. **激活新 Spec 静默取消旧 Active**：无二次确认。操作前**先 `specService.list(status="active")` 列出当前 Active 提示用户**。
4. **文件名 slug 由标题直接生成，没有重名/空 slug 保护**：相同标题写同一个 `.spec.md`，纯符号标题可能生成 `.spec.md` 空文件名。**让用户保证标题唯一 + 含字母数字。**
5. **删除是 best-effort，不是事务**：`specService.delete` 按 "Todo 子任务 → Todo → Spec 文件 → DB 记录" 尝试清理，但 Todo 删除或文件删除失败只 log error，仍继续删 DB，可能留下孤儿 Todo / 文件。**删完最好手工 `ls .ccpanes/specs/` 确认。**
6. **Archived 状态的 Spec 可能被移到归档目录**。如果 UI 入口找不到归档内容，优先用 CC-Panes 内置 Spec 服务读取 resolved path，不要手动猜路径。

---

## 推荐流程

### 完整流程（大功能）

1. **规格设计**：用 `/ccpanes:openspec` 引导按 Proposal/Design/Tasks 结构起草内容（可以先写在临时 md）
2. **创建 Spec**：让用户在 CC-Panes UI 创建 Spec 并粘贴起草内容；或 Claude 用 `specService.create({projectPath, title, tasks: [...]})`（前端 invoke，不是 MCP）
3. **激活 Spec**：UI 操作，或 `specService.update(specId, {status: "active"})`（先列出当前 Active 提示用户）
4. **执行任务**：终端工作时自动同步进度到 `## Tasks`，终端退出自动追加 `## Log`
5. **归档 Spec**：所有任务完成后，UI 归档或 `specService.update(specId, {status: "archived"})`

### 简化流程（小功能）

直接创建 Spec + 任务列表 → 激活 → 执行 → 归档。

---

## 常见操作快查

### 列出 Spec
```typescript
specService.list(projectPath, status?)  // status: "draft" | "active" | "archived" | undefined
```

### 读 Spec 内容
```typescript
specService.getContent(projectPath, specId)
```

### 同步任务（双向）
```typescript
specService.syncTasks(projectPath, specId)
// Todo 子任务状态 ↔ Spec 文件的 ## Tasks checkbox
```

### 终端退出自动日志（被动机制）
- 自动日志由 CC-Panes 的终端退出事件触发。
- 具体实现位置随版本变化；需要调试时以当前源码中的 Spec 服务和 terminal-exit 监听为准。
- 行为：(1) sync tasks（回收 AI 在文件里改的 checkbox）(2) `git diff --stat HEAD` (3) 追加到 `## Log`
- **AI 不用主动调** —— 终端正常退出自动跑。

---

## 反模式

- ❌ 用 `mcp__ccpanes__create_todo({todoType: "spec"})` 创建 Spec —— 字段不存在，只会创建普通 Todo
- ❌ 把 `sync_spec_tasks` 当 MCP 工具调 —— 它是 Tauri command，不是 MCP
- ❌ 改 Spec 文件头部 `> Status:` 期望生效 —— DB 状态才是 ground truth
- ❌ Archived 状态改回 Draft —— 文件不会移回 `specs/`，后续解析全错
- ❌ 删完 Spec 不检查 —— best-effort 删除可能留下孤儿 Todo/文件
- ❌ 激活新 Spec 不提示用户 —— 旧 Active 静默丢失
- ❌ 标题用纯符号或与现有 Spec 重名 —— 会冲突写同一 `.spec.md`

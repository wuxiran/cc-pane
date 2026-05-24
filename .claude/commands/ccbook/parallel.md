---
name: parallel
description: 多 worker 并行编排 — Claude Task 子 agent 用于只读研究/审查类工作，CC-Panes launch_task 用于代码型并行实现（必须搭配 worktree 隔离）。主 Agent 不直接写代码，负责拆分、调度、汇总。
trigger: |
  - 用户要求"并行跑"、"分头执行"、"开 N 个 worker"、"parallel"、"fan out"
  - 任务可拆成 ≥2 个相互独立的子任务（不共享文件、无强依赖）
  不触发：
  - 子任务共享同一文件 / 有依赖链 / 是单点小修复 → 直接单 agent 顺序做
  - 纯跨项目 fan-out → 改用 ccpanes:parallel-run skill
---

# parallel — 多 worker 并行编排（Claude Task + CC-Panes 双层）

你是并行编排 Agent。主 Agent 在主仓库，**不直接写代码**，负责：拆分需求、按 worker 类型派活、监控完成、汇总 diff、由用户拍板后提交。

---

## 何时用 / 何时不用

**用**：

- 任务可拆成 ≥2 个**完全独立**的子任务（独立模块 / 只读研究 / 并行检查）
- 高价值且独立子任务足够大，串行做太慢

**不用**：

- 子任务共享同一文件、有顺序依赖、是数据库迁移之类不可并发的操作
- 单点小修复 / < 50 行改动 → 单 agent 顺序更快更省事
- 纯跨项目 fan-out（同一脚本/同一 prompt 跑在 N 个项目）→ 用 [`ccpanes:parallel-run`](#与-ccpanes-parallel-run-skill-的关系)

---

## 两层并行模型（关键）

| 层 | 工具 | 适用 worker 类型 | 是否改代码 |
|----|------|------------------|------------|
| **Claude Task 子 agent** | `Task(subagent_type=...)` | research / plan / check / debug 等**只读**或**轻量分析** | 否（默认） |
| **CC-Panes launch_task** | `mcp__ccpanes__launch_task(...)` | implement / 大规模 refactor 等**代码型**实现 | 是（必须配 worktree 隔离） |

**默认分层策略**：
- 研究、规划、审查 → Claude Task（同进程，便宜，无 git 风险）
- 实现、调试、改大文件 → CC-Panes launch_task + worktree

---

## 项目实际可用的子 Agent

在 `.claude/agents/` 下，按 frontmatter 列出：

| Agent | 用途 | 默认走哪层 |
|-------|------|------------|
| `research` | 分析代码库（只读） | Claude Task |
| `plan` | 创建任务计划（只读 + 文档） | Claude Task |
| `check` | 检查代码质量（只读） | Claude Task |
| `debug` | bug 修复（写代码） | CC-Panes launch_task + worktree |
| `implement` | 功能实现（写代码） | CC-Panes launch_task + worktree |
| `tauri-reviewer` | Tauri IPC 审查（只读） | Claude Task |
| `rust-ts-bridge-checker` | Rust-TS 桥接对比（只读） | Claude Task |

**注意**：这些是 Claude Code 的 `.claude/agents/` 子代理，不是 `launch_task` 的 `cliTool` 参数（后者只接 `claude` / `codex`）。代码型 worker 用 launch_task 时是启**一个新的 Claude/Codex 实例**在 worktree 里跑，不直接调这些子 agent。

---

## 执行流程

### Phase 1：了解项目 + 当前状态

```bash
cat CLAUDE.md         # 必读，了解项目规范
git status            # 当前工作树状态
git log --oneline -5  # 最近上下文
```

### Phase 2：与用户确认拆分

- 要做什么功能 / 涉及哪些模块？
- 哪些子任务独立、可并行？哪些必须串行？
- 用 `AskUserQuestion` 确认拆分方案 + 哪些走 Task 哪些走 launch_task

### Phase 3：worktree 准备（代码型 worker 必做）

**对每个会改代码的 worker**，必须有独立 worktree。两种方式：

- **手动**：让用户在 CC-Panes UI 的 Worktree 管理器先建好 worktree，登记到 ccpanes 项目
- **命令行**：`git worktree add ../<repo>-<feature> -b <branch>` 后用 `mcp__ccpanes__add_project_to_workspace` 注册

**只读 worker（research/check/plan）不需要 worktree**，直接在主仓库或临时 checkout 跑。

> **不要**让多个代码型 worker 在同一个工作树里并行写文件 —— 必然冲突。

### Phase 4：派 worker

**只读类（Claude Task 子 agent）**：

```
Task(
  subagent_type: "research" | "plan" | "check" | ...,
  description: "<3-5 字摘要>",
  prompt: "<完整任务描述,自包含上下文 + 期望产出格式>"
)
```

并行派多个：单条消息里发多个 `Task` tool call，Claude harness 会并发执行。

**代码型（CC-Panes launch_task + worktree）**：

```
mcp__ccpanes__launch_task(
  projectPath: <worktree 路径，list_projects 取到的精确字符串>,
  cliTool: "claude" | "codex",
  runtimeKind: "local" | "wsl",
  title: "Worker: <模块名>",
  prompt: <自包含任务描述 + 文件范围 + 完成定义>
)
```

启完立刻 `register_plan_worker(leaderId, sessionId)`（前提是 Phase 1.5 注册过 leader —— 见下方"完成监控"），把 workerId 写进 worker prompt 让它完成时上报。

### Phase 1.5（必做，监控前提）：注册 leader

启动任何 worker 前，主 Agent 先注册自己为 leader：

```
mcp__ccpanes__register_plan_leader(
  planPath: <plan 文件或本次任务标识>,
  projectPath: <主仓库路径>,
  cliTool: "claude",
  sessionId: <环境变量 CC_PANES_PTY_SESSION_ID>,
  title: "Parallel orchestrator: <任务>"
)
```

记下返回的 `id` 作为 `<leaderId>`。

### Phase 5：监控 worker 完成

| Worker 类型 | 完成通知 | 主 Agent 怎么知道 |
|-------------|---------|---------------------|
| Claude Task 子 agent | 同步返回（Task tool 调用直接拿结果） | 等 tool result |
| CC-Panes launch_task worker | PTY `report_to_leader` + `update_task_binding` | 等 `[worker-report]` 行 |

**重要**：多个 worker 并发时，PTY `report_to_leader` 在 leader busy 时会**静默丢失**（见 [[ccpanes-worker-report-pty-dropout]] memory）。所以代码型 worker 的 prompt **必须**包含：

```
## 收尾(必须执行)
1. update_task_binding(id=<workerId>, status="completed", progress=100, completionSummary="...")
2. report_to_leader(workerId=<workerId>, status="completed", summary="...")
```

主 Agent 兜底：等一阵后 `reconcile_plan_collaboration(leaderId)` 扫一遍所有 worker binding 的最终状态。

### Phase 6：汇总

每个 worker 完成后，记录：

- worker 类型 + 任务 + 文件范围
- 完成摘要 / 失败原因 / 阻塞
- diff 概况（`git -C <worktree> diff --stat`）

汇总成表格给用户：哪些 worker 通过、哪些失败、合并顺序建议。

### Phase 7：合并 + 提交（用户拍板）

- **worker 不自己 commit**
- 主 Agent 用 `git -C <worktree> diff` 拉每个 worker 的改动
- 按用户约定的顺序在主仓库 cherry-pick / merge / 手动应用
- 测试通过 + **用户明确确认** 后，**主 Agent 才** commit
- 或者：把每个 worktree 留给用户自己 commit，主 Agent 只汇报

> **永远不在用户没确认前 push。**

---

## 与 ccpanes:parallel-run skill 的关系

| 维度 | `/ccbook:parallel`（本 skill） | `ccpanes:parallel-run` |
|------|------------------------------|------------------------|
| 适用 | **单项目内**多 worker 编排（含 Task 子 agent + launch_task 混合） | **跨项目** fan-out（同一脚本/同一 prompt 跑在 N 个不同项目） |
| worker 形态 | Task 子 agent 或 launch_task | 仅 launch_task |
| git 编排 | 主 Agent 汇总 worktree diff | 各项目独立提交 |
| 触发 | 本项目内独立模块并行 | "在所有前端项目里跑这个迁移" |

混淆风险：用户说"并行跑"两者都可能触发。判断标准：**改动是否在同一个项目里**。同一项目走本 skill，跨项目走 `ccpanes:parallel-run`。

---

## 反模式

- ❌ 把代码型 worker 都丢到主仓库并行写 → git 必爆
- ❌ Task 子 agent 和 launch_task 不分，统一用一个 → 简单任务多花一倍 token，复杂任务又缺隔离
- ❌ 忘记 `register_plan_leader` → worker 完成无法自动通知，只能轮询
- ❌ worker 只 `report_to_leader` 不 `update_task_binding` → leader busy 时反馈丢失
- ❌ 主 Agent 自己 commit 不等用户确认
- ❌ 子任务有依赖还硬拆并行 → 后做的覆盖前做的

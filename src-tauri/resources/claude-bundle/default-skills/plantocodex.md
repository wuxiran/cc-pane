---
name: ccpanes-plantocodex
description: Orchestrate the Plan-to-Codex handoff — Claude plans (EnterPlanMode → plan file), registers leader/worker, hands the plan to Codex for execution, then monitors via worker self-report. Use when the user says "Claude 规划 Codex 执行"、"plan-to-codex"、"先规划再交给 Codex"、"hand off this plan"、"派给 Codex 实现". Claude does NOT write code in this workflow — Codex does.
---

# Plan → Codex 交接

## Phase 1: Plan

`EnterPlanMode` → 探索/设计 → 写 plan 到 `.claude/plans/*.md` → `ExitPlanMode`。记住 plan 路径作为后续所有调用的 `planPath`。

## Phase 1.5: 登记 Leader

```
mcp__ccpanes__register_plan_leader(
  planPath, projectPath, cliTool: "claude",
  sessionId, paneId, tabId,        # 能拿到就传
  title: "Plan: <简述>",
  metadata: { "monitorMode": "worker_report" }
)
```

记录 `leaderId`。重启后不知道 leaderId 时 `get_plan_collaboration(planPath)` 取回。

## Phase 2: 确认目标

`AskUserQuestion`：
- 目标窗口：新建 Codex / 新建 WSL Codex / 已有窗口
- 监控模式：`worker_report`（默认省 token）/ `leader_poll`

"已有窗口"时用 `list_sessions` + `list_panes` 匹配 sessionId/paneId/tabId。

## Phase 3: 发送 Plan + 登记 Worker

**WSL 路径转换**：`C:\Users\...` → `/mnt/c/Users/...`

Codex prompt 模板：

> 请阅读以下 plan 文件并按方案实现。完成后用后续给你的 workerId 回报。Plan：`<plan_path>`

新建窗口 → `launch_task(cliTool: "codex", ...)`；已有窗口 → `submit_to_session`。发送后立即：

```
register_plan_worker(leaderId, sessionId, cliTool: "codex", projectPath,
                     title, prompt, metadata: { "monitorMode": "worker_report" })
```

`worker_report` 模式补一条上下文给 worker：

> 你的 workerId = `<workerId>`。完成时 `update_task_binding(id, status: "completed", progress: 100, completionSummary)`；失败 `status="failed"`。可选给 leader `submit_to_session` 发短摘要。

## Phase 4: 监控

| 模式 | leader 行为 |
|---|---|
| **worker_report**（默认） | 不轮询。worker 自己 `update_task_binding` 上报。只在用户问/超时时 `reconcile_plan_collaboration(leaderId)` |
| **leader_poll** | 循环 `reconcile_plan_collaboration` 看 `isLive`/`status`；终结或要详情时 `get_session_output(sessionId, lines: 200)` |

## Phase 5: 检查结果

1. `get_plan_collaboration(leaderId, verbose: true)`
2. 必要时 `get_session_output(sessionId, lines: 500)`
3. `git diff --stat`
4. 汇报：完成步骤 / 代码摘要 / 错误 / 是否需恢复 worker

## Recovery

planner 重启后已知 `planPath`：`get_plan_collaboration(planPath)` → 有 `resumeId` 用 `launch_task(resumeId, cliTool)` 恢复；只有 `planPath` 则重启 Codex 重新发送。stale `paneId/tabId` 不可靠。

## 要点

- **Claude 不写代码**，由 Codex 完成
- plan 必须详细到 Codex 能独立执行
- 监控低 token：worker 主动回报 + compact reconcile + 按需读输出

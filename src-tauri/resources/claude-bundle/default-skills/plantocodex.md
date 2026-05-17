# Plan -> Codex 交接工作流

你是 Plan-to-Codex 编排 Agent：Claude 规划 → 登记 leader/worker → 交 Codex 执行 → 监控结果。

## Phase 1: Plan

`EnterPlanMode` → 探索/设计 → 写 plan 到 `.claude/plans/*.md` → `ExitPlanMode`。**记住 plan 文件路径**，作为后续所有调用的 `planPath`。

## Phase 1.5: 登记 Leader

```
mcp__ccpanes__register_plan_leader(
  planPath, projectPath, cliTool: "claude",
  sessionId, paneId, tabId,   // 能拿到就传
  title: "Plan: <简短描述>",
  metadata: { "monitorMode": "worker_report" }
)
```

记录 `leaderId`。重启后未知 `leaderId` 时先 `get_plan_collaboration(planPath)` 取回。

## Phase 2: 确认目标

用 `AskUserQuestion` 询问：
- 目标窗口：新建 Codex / 新建 WSL Codex / 已有窗口
- 监控模式：`worker_report`（默认省 token）/ `leader_poll`

"已有窗口"：用 `list_sessions` + `list_panes` 匹配 sessionId/paneId/tabId。

## Phase 3: 发送 Plan 并登记 Worker

**WSL Codex 路径转换**：`C:\Users\xxx\...` → `/mnt/c/Users/xxx/...`

**Codex prompt 模板**：
> 请阅读以下 plan 文件并按其中方案实现。完成后用后续给你的 workerId 回报状态。Plan 文件：`<plan_path>`

新建窗口用 `launch_task(cliTool: "codex", ...)`；已有窗口用 `submit_to_session`。

发送后立即：

```
mcp__ccpanes__register_plan_worker(
  leaderId, sessionId, cliTool: "codex", projectPath,
  title, prompt,
  metadata: { "monitorMode": "worker_report" }
)
```

记录 `workerId`。`worker_report` 模式下补一条上下文给 worker：

> 你的 workerId 是 `<workerId>`。完成时调 `update_task_binding(id, status: "completed", progress: 100, completionSummary)`；失败 status="failed"。可选给 leader `submit_to_session` 发短摘要。

## Phase 4: 监控

**worker_report**（默认）：worker 完成时主动调
`update_task_binding(id: <workerId>, status: "completed"|"failed", progress: 100, completionSummary: "...")`
上报；leader 只在用户问/超时时调 `reconcile_plan_collaboration(leaderId)` 看状态。**不要频繁拉终端输出**。

**leader_poll**：循环 `reconcile_plan_collaboration` 看 `isLive`/`status`，只在状态终结或用户要详情时 `get_session_output(sessionId, lines: 200)`。

## Phase 5: 检查结果

1. `get_plan_collaboration(leaderId, verbose: true)`
2. 必要时 `get_session_output(sessionId, lines: 500)`
3. `git diff --stat` 看变更
4. 汇报：完成步骤、代码摘要、错误、是否需恢复 worker

## Recovery

planner 重启后已知 `planPath`：

```
get_plan_collaboration(planPath)
reconcile_plan_collaboration(planPath)
```

- 有 `resumeId` → `launch_task(resumeId, cliTool)` 恢复
- 只有 `planPath` → 重启 Codex 重新发送
- stale `paneId/tabId` 不可靠

## 要点

- **Claude 不写代码**，代码由 Codex 完成
- plan 文件必须详细到 Codex 能独立执行
- 监控低 token：worker 主动回报 + compact reconcile + 按需读输出

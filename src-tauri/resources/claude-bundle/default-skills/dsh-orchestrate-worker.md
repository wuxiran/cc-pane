---
name: ccpanes-dsh-orchestrate-worker
description: 从 dsh 会话派 Claude/Codex 终端 worker 并接收完成回执。 Use when 用户在 dsh 里说"开个 codex 窗口做 X"、"派个终端任务"、"做完告诉我"、"orchestrate a worker"。仅适用于 dsh 会话内的 agent；终端 CLI 里的编排走 plantocodex/plantocc。
---

# dsh-orchestrate-worker — 从 dsh 派终端 worker 并收回执

你正运行在 DeepSeek Harness（dsh）的一个会话里。CC-Panes 的 MCP 工具让你能开真实的 Claude/Codex 终端窗口干活；本 skill 额外打通**回执**：worker 完成后，它的报告会以一条 `[worker-report] ...` 用户消息的形式**直接出现在你的这个对话里**——你不需要轮询。

## 完整流程

### 1. 起 worker 终端

```
launch_task(projectPath, cliTool: "codex" | "claude", prompt: "任务描述…", title: "…")
→ 返回 sessionId（记下来）
```

### 2. 注册 leader（你自己）与 worker

```
register_plan_leader(
  planPath: "<plan 文件路径或任务描述文件>",
  projectPath: "<项目路径>",
  sessionId: "",            ← 留空
  leaderKind: "dsh",        ← 关键！表明你是 dsh 会话
)
→ 返回 leader binding（记下 id）

register_plan_worker(
  planPath: 同上,
  projectPath: 同上,
  sessionId: "<第 1 步的 sessionId>",
  parentId: "<leader binding 的 id>",
)
```

`leaderKind: "dsh"` 时服务端会自动识别你的会话（调用发生时正在跑轮次的那个 dsh 会话就是你），不需要也拿不到自己的 session id——**不要**试图伪造一个。

### 3. 在 worker 的 prompt 里写明回报义务

派发 prompt 末尾必须带一句（否则 worker 不知道要回报）：

> 完成后调用 ccpanes MCP 的 `report_to_leader(workerId: "<worker binding id>", status: "completed", summary: "<一句话结果>")`。失败也要报，status 用 "failed"。

### 4. 等回执（不要忙等）

回执会以 `[worker-report] id=… status=… summary=…` 的用户消息出现在你的对话里。**在那之前你可以正常结束当前轮次**——消息到达会自动唤起你的下一轮。

中途想看进展（可选）：

```
get_session_status(sessionId)          ← 状态值是小写驼峰：idle / thinking / toolRunning / waitingInput / exited
get_session_output(sessionId, 100)     ← 读最近输出
```

### 5. 追问 / 继续对话

收到回执后要继续给 worker 派活或追问，直接：

```
submit_to_session(sessionId, "下一步：…")
```

worker 忙时想插话不要重复 submit——先 `wait_for_session(sessionId, waitFor: ["idle","waitingInput"])`。

## Gotchas（都是实测踩过的）

- **codex worker 可能"活着但一动不动"**：prompt 送达后停在 TUI 里从未提交——进程活着、状态正常，但输出永远为零。判定：`get_session_output` 长时间空 + 状态不变。解法：`write_to_session(sessionId, "\r")` 发一个裸回车，**不要 kill 重发**（大概率复现同一问题）。
- **`wait_for_session` 的状态名是小写驼峰**（`idle` / `waitingInput` / `exited`），大写开头会报 unknown variant。
- **回执可能丢**：你这个 dsh 实例被关掉期间 worker 完成的话，回执无处投递（会被诚实丢弃并在 worker 的 metadata 记 `reportDropped`）。重开后用 `query_task_bindings(planPath: …)` 查 worker 的最终状态兜底。
- **一次只当一个 leader**：同一 planPath 重复注册会复用既有 leader 记录；开新任务用新的 planPath。

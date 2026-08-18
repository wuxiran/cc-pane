---
name: ccpanes-dispatch-task
description: "Dispatch a durable task to any registered CC-Panes CLI. Use for cross-CLI handoff, implementation, review, research, or resume workflows."
---

# dispatch-task - 跨 CLI 通用派发

使用 `mcp__ccpanes__dispatch_task` 派发新任务或恢复任务。它不假设发起者和目标的组合：Claude、Codex、Gemini、Kimi、GLM、OpenCode、Cursor、Grok 等已注册 CLI 都走同一个协议。

`launch_task` 只保留给旧流程兼容。只要任务需要跨会话追踪、父子关系或收尾状态，优先 `dispatch_task`。

## 选择目标

1. 用户明确指定 CLI 时照做。
2. 未指定时，优先采用当前项目已绑定、且启动配置兼容的 CLI；无明确偏好时默认 `claude`。
3. 目标 CLI 不支持 MCP 也可以接收首段 prompt，但不能假定它能自行回写状态或给 leader 发报告。此类任务必须通过 PTY 输出和会话状态验收。
4. `resumeId` 仅能用于目标适配器声明支持恢复的 CLI；不支持时 `dispatch_task` 会直接拒绝，改为新 prompt 派发。

不要把"评审一定用 Codex"、"实现一定用 Claude"当作规则。评审优先选择与当前实例不同、且用户可用的 CLI；实现优先选择对项目规则、权限模式和验证命令匹配的 CLI。

## 派发

先准备自包含的 prompt：目标、文件范围、验收命令、禁止项、以及没有 MCP 时也能在终端里交付的收尾格式。若当前会话已登记为 leader，传 `parentBindingId`；否则可只传 `parentSessionId` 记录来源。

```text
mcp__ccpanes__dispatch_task(
  projectPath: <list_projects 返回的原样路径>,
  cliTool: <目标 cli id>,
  runtimeKind: "local" | "wsl" | "ssh",
  title: "<角色>: <简短任务>",
  parentBindingId: <可选，当前 leader binding id>,
  prompt: <完整任务 prompt>
)
```

返回中必须记录：

- `bindingId`：持久化任务的主键，也是后续查状态的首选键。
- `dispatchTaskId`：本次派发的稳定任务编号。
- `sessionId`：PTY 交互、读取输出、终止任务使用。
- `dispatchEnvelope`：解析后的目标 CLI、交付方式、父关系与 MCP 能力快照。

## Worker 收尾约定

`dispatch_task` 在启动后的会话环境中注入：

```text
CC_PANES_TASK_BINDING_ID
CC_PANES_DISPATCH_TASK_ID
```

因此 prompt 不必预先猜测 binding id。支持 `ccpanes` MCP 的 worker 在完成或失败时使用环境变量中的 binding id：

```text
mcp__ccpanes__update_task_binding(
  id: <CC_PANES_TASK_BINDING_ID>,
  status: "completed" | "failed",
  progress: 100,
  completionSummary: "改动范围、验证命令与结果、未解决问题"
)
```

有 `parentBindingId` 且需要立即向父会话回传时，再调用 `report_to_leader(workerId=<CC_PANES_TASK_BINDING_ID>, ...)`。`update_task_binding` 必须在前，PTY 报告只是加速反馈，不是唯一记录。

不支持 MCP 的 worker 不要求伪造这些调用；prompt 必须要求它把同样的改动、验证和阻塞信息打印到终端，leader 通过会话输出验收。

对于没有原生命令/Skill 目录、但支持会话提示词的 CLI，CC-Panes 会把当前配置选中的可移植内置 Skill 注入本次会话提示词；有原生交付方式的 CLI 仍优先使用原生目录，避免重复加载。需要 `ccpanes` MCP 的 Skill 只会在该 MCP 启用时注入。

## 查询与监控

```text
mcp__ccpanes__get_task_dispatch(bindingId: <bindingId>)
mcp__ccpanes__get_session_status(sessionId: <sessionId>)
mcp__ccpanes__get_session_output(sessionId: <sessionId>, lines: 300)
```

`get_task_dispatch` 返回解析后的 `dispatchEnvelope` 和当前 `TaskBinding`，不需要手动读取 `metadata.dispatchEnvelope`。对于不支持 MCP 的目标，`TaskBinding` 可能一直保持 `running`，此时以 `get_session_status`、PTY 尾部输出和实际 diff/测试结果为准。

## 反模式

- 不要先 `launch_task` 再临时补建 binding；会丢失启动前的持久化关系。
- 不要在 prompt 里硬编码未知的 worker id；使用 `CC_PANES_TASK_BINDING_ID`。
- 不要因为目标没有 MCP 就拒绝派发；降级为会话监控和输出验收。
- 不要根据 CLI 名称推断能力；以 `dispatchEnvelope`、启动配置和实际会话状态为准。

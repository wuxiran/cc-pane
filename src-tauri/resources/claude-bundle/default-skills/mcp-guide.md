---
name: ccpanes-mcp-guide
description: How to use the {{app_name}} core MCP tools: dispatch, session I/O, wait, notify, memory, todo, AI panel. 触发词：怎么派任务、怎么等会话、怎么发控制键、通知卡片、记忆写哪个 scope。编排其他会话之前、或某个 ccpanes 工具调用不对劲时先读这里。
---

# {{app_name}} core MCP 使用指南

会话里挂的 `{{mcp_server_name}}` 是 **core 面**：会话、派发、编排、plan、memory、通知、AI 面板，
外加几个只读查询。工具描述故意写得很短，细节都在这里。管理台操作（工作空间、启动档、
共享 MCP、runner、media、browser、文件）不在会话 MCP 里，见 `ccpanes-admin` skill。

## 派发与跟踪

```
dispatch_task(projectPath, prompt | resumeId, cliTool?, parentBindingId?, parentSessionId?, …)
  → { taskId, bindingId, sessionId, status, cliTool, mcp, notice }
get_task_status(bindingId)   → TaskBinding + 派发信封（父子关系、目标 CLI、mcp 能力）
get_task_status(taskId)      → 只查启动事件，不代表任务进度
wait_for_session / get_session_output → 真正的进度
```

- `prompt` 与 `resumeId` 互斥。恢复会话时不注入 prompt。
- 自己是 leader 时一定传 `parentBindingId`（没有 binding 就传 `parentSessionId`），worker 才能 `report_to_leader`。
- 目标 CLI 不支持 MCP（返回值 `mcp.canControlOrchestration=false`）时，它收得到首条 prompt，但不会主动回报；用 `wait_for_session` + `get_session_output` 兜底。
- `placement`：`beside` 在调用者旁边分屏并聚焦（默认，用户立刻能看到）；`tab` 作为标签加入调用者所在窗格，只在用户明确要求"后台 / 同一窗格"时用；`silent` 不切布局、不切视图、不弹提示。指定了 `paneId` 就按 `paneId` 落位，`placement` 忽略。默认前端**不会**为 agent 启动跳布局，只弹一条可跳转提示。
- `layoutName` 不存在时前端自动建布局；`list_panes` 查现有 `layoutId` / `paneId`。
- `profileId` 显式指定启动配置并覆盖工作空间绑定；YOLO 配置受设置里 `orchestrator.allowMcpYoloProfiles` 门控。
- `runtimeKind`（local / wsl / ssh）高于工作空间默认环境。

恢复会话：`list_launch_history(projectPath)` 或 `list_resume_sessions(cliTool, projectPath)` 拿 `resumeSessionId` / `sessionId`，
再 `dispatch_task(resumeId=…, cliTool=…, runtimeKind=…)`。

## 等待与读输出

`wait_for_session(sessionId | launchId, waitFor: [...], timeoutMs?)`

- 合法状态（小写驼峰）：`initializing` `idle` `thinking` `toolRunning` `compacting` `waitingInput` `error` `exited`。
- 事件驱动、无忙轮询；`waitingInput` / `error` 会立刻带 `blockedReason` 返回。
- `timeoutMs` 默认 180000，范围 1000..570000；超时后再调一次即可续等。

`get_session_output(sessionId, lines?)`

- **默认只返回尾部 50 行**（纯文本，ANSI 已剥）。要更多传 `lines`（100–500 常见），`lines: 0` 才是全部缓冲——别在循环里传 0。
- 已退出的会话 5 分钟内仍可读。
- 判断任务是否完成看输出和 `get_session_status`，不要只看 `get_task_status(taskId)`。

## 往会话里写东西

| 想做什么 | 用哪个 |
|---|---|
| 发 prompt、slash 命令、多行文本 | `submit_to_session(sessionId, text)`：bracketed-paste 整体写入，等 TUI 就绪后单独补一个回车 |
| 发控制键、不要自动回车 | `write_to_session(sessionId, text)` |

控制键必须用 JSON `\u` 转义（`\x` 不是合法 JSON，写 `"\\x03"` 只会送出 4 个字面字符）：
Esc `"\u001b"`，Shift+Tab `"\u001b[Z"`，Ctrl+C `"\u0003"`，Ctrl+D `"\u0004"`，回车 `"\r"`（CR 不是 LF）。
控制键只能走 `write_to_session`——`submit_to_session` 总会追加回车，Esc 会变成 Esc+Enter。字面反斜杠写 `\\`。

Codex worker 偶尔"活着但一动不动"（prompt 到了 TUI 却没提交）：`write_to_session(sessionId, "\r")` 发一个裸回车，不要 kill 重发。

## leader / worker

- `register_plan_leader(planPath, projectPath, sessionId, …)`：`sessionId` 是 leader 自己的 PTY 会话 ID（环境变量 `CC_PANES_PTY_SESSION_ID`）。从 dsh 网页会话调用时传 `leaderKind="dsh"`，`sessionId` 可空串，worker 回执会以聊天消息送回。
- `register_plan_worker(...)`：只在复用旧会话时手动登记；新派的 worker 用 `dispatch_task(parentBindingId)` 自动登记。`workerKind="reviewer"` 表示评审员。
- `send_to_worker(workerSessionId | planId, message, submit?)`：给一个或该 plan 全部 worker 下发；worker 忙时排队，回到 idle / waitingInput 再投。`submit=false` 只放进输入框不回车。
- `report_to_leader(workerId, status?, summary?)`：自动上报没触发时（比如状态早已 completed）手动补一次。
- `get_plan_collaboration` / `reconcile_plan_collaboration`：默认 compact，`verbose=true` 才带 prompt / metadata / completionSummary。

## 通知与面板

`trigger_notification(kind, title, body?, sessionId?, requiresInput?, inputPlaceholder?, …)`

- `requiresInput=true` 时卡片带输入框，用户输入会以提交形式写回 `sessionId` 指定的会话——此时 `sessionId` 必填，自己的从 `CC_PANES_PTY_SESSION_ID` 取。
- 只在长任务完成、需要用户决策、出错需人介入时发；琐碎问答不要发。

AI 面板（`open_ai_panel` / `update_ai_panel` / `close_ai_panel` / `claim_ai_panel` / `get_ai_panel_events` / `list_ai_panel_history`）

- `display`：`auto`（默认，听用户偏好）/ `dialog`（请求弹框）/ `dock`（请求右侧 Dock）/ `silent`（只标未读）。`dialog` / `dock` 可盖过用户的自动打开偏好，但受「允许 AI 请求弹出面板」总闸约束。
- **返回值 `delivery`（dialog / dock / unread / disabled / unknown）才是真实投递结果**。调用成功不等于用户看见了，先读 `delivery` 和 `hint` 再向用户描述，不要一看到 panelId 就说"已弹出"。
- `close_ai_panel` 只是离开活跃集并释放持有者，内容仍在历史里；`claim_ai_panel` 认领无人持有的历史面板，事件序号从 1 重来，仍被活会话持有会被拒绝。

## 记忆与待办

`memory_add(title, content, scope?, category?, importance?, workspaceName?, projectPath?, sessionId?, tags?)`

- `scope`：`global` / `workspace` / `project`（默认）/ `session`；`project` 必填 `projectPath`，`session` 必填 `sessionId`，`workspace` / `project` 建议填 `workspaceName`。
- `category`：decision / lesson / preference / pattern / fact（默认）/ plan，或自定义。
- `importance` 1–5；**≥ 4 才会在会话启动时被召回**（项目 → 工作空间 → 全局，最多 5 条）。
- `memory_search(query, scope?, category?, minImportance?, sortBy?, limit?, offset?)`：`sortBy` 可选 relevance / created_at / updated_at / importance。
- 环境变量 `CC_PANES_*` 全缺失说明 CLI 不在 {{app_name}} 管控下，不要写共享池。

待办：`create_todo` / `update_todo` / `query_todos`。AI 代替用户创建的派工项必须 `todoType="ai-work-item"`；`query_todos(excludeTodoType="ai-work-item")` 只看用户自己的任务；`scope` + `scopeRef`（工作空间名或项目路径）限定范围。

## plan 召回

- `search_plans(projectPath, keyword, sessionId, workspaceName?, limit?)`：关键词匹配 intent / followups / tags，命中会计热度（同 plan + 同 session 去重）。用于"上次 / 之前 / 我们做过"。
- `list_recent_plans(projectPath, workspaceName?, limit?)`：按时间看最近的，不计热度。
- `set_plan_archived(id, archived)`：归档后不再召回，可恢复。

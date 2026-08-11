# 为终端会话增加任务队列
ID: add-terminal-task-queue
Status: APPROVED
Human-confirmed: 2026-08-10 (user requested implementation)
Created: 2026-08-10

## Why

CC-Panes 的主要用户会同时监督多个 CLI agent，目前只能等一个会话结束后再手动切回终端输入下一项任务，或者把待办放在应用之外。参考 CCPanel 的任务队列后，本变更把“排好后续任务，当前轮结束后自动继续”放到每个 CLI 终端的状态栏中，并修复参考实现依赖终端文本猜测完成状态、把通知误当作可确认提示、发送失败却提前出队，以及错误后自动发送 `继续` 等无人值守问题。这直接服务于 `docs/STRATEGY.md` 的 Track A（可预测的会话执行）、Track B（工作协调靠近执行会话）与 Track C（显式的恢复和兼容边界）。

## What changes

- 在终端设置中增加全局“任务队列”开关；关闭时隐藏所有状态栏入口，并以同一 SQLite 事务禁止后续认领，但保留已有队列。
- 在每个已启动 CLI 的终端状态栏增加任务队列图标、数量徽标和非颜色独占的状态提示；点击后打开紧凑 Popover。
- 队列面板支持添加多行任务、粘贴剪贴板图片、快捷任务、删除单项、清空、暂停/继续，以及独立的“无人值守”开关。
- 每个队列绑定到准确的 PTY session；当前任务进入可靠的 `Idle` 后按 FIFO 自动提交下一项。
- 复用并收紧 `SessionStateMachine::status_for_automatic_submit` 的 hook + PTY 双陈旧门控，在认领前和写入前做状态双检；进程重启后必须先建立新的观察基线，不能把一张旧 `Idle` 快照当作完成证据。
- 队首项目在提交成功前保持在队列中。发送失败或结果不确定时停止派发并显示错误，由用户显式重试或删除，绝不静默丢任务或自动重复发送。
- 无人值守不再模拟按键选择界面默认项。首版仅在 Claude 的同步 `PermissionRequest` hook 提供非空原生 `tool_use_id` 时，按用户明确开启的无人值守设置返回结构化 `allow`；Notification、普通等待提示、鉴权/API 错误、未知 payload、失去写入租约或会话退出均不自动响应。
- 图片由 Rust 后端直接从系统剪贴板保存到应用自有的队列图片目录，并向前端返回不可伪造的引用；队列 API 不接受任意本地文件路径。
- 队列状态和项目持久化到本地 SQLite。Popover 收起、标签页隐藏或 WebView 重载不影响派发；CC-Panes Rust 后端退出后停止派发，重启时按持久化状态恢复并重新校验。
- 首版范围是 Tauri 桌面端。`cc-panes-web`/Docker 不显示入口，也不交付队列 CRUD、后台执行或无人值守；Web 支持作为独立后续 change 设计。
- 中文和英文文案同步交付。

## Product copy

| 场景 | 中文 | English |
|---|---|---|
| 设置项 | 任务队列 | Task queue |
| 设置说明 | 在每个 CLI 状态栏显示任务队列，并在当前任务结束后自动提交下一项。关闭后保留已有任务。 | Show a task queue in every CLI status bar and submit the next item after the current task finishes. Existing items are kept when disabled. |
| 面板标题 | 任务队列 | Task queue |
| 队列说明 | 当前任务结束后，按顺序自动提交下一项。 | Submit the next item in order after the current task finishes. |
| 无人值守 | 无人值守 | Unattended |
| 无人值守说明 | 自动批准 Claude 的结构化工具权限请求。未知提示、错误或会话退出时仍会暂停并等待处理。 | Automatically approve Claude's structured tool permission requests. Unknown prompts, errors, and session exit still pause for review. |
| 无人值守风险确认 | 无人值守会允许 Claude 在无需逐次确认的情况下使用工具。仅在你信任当前任务和工作区时开启。 | Unattended lets Claude use tools without per-request confirmation. Enable it only when you trust the current task and workspace. |
| 空态 | 队列为空。添加任务后，将在当前任务结束时自动执行。 | The queue is empty. Add a task to run it after the current task finishes. |
| 输入占位 | 输入要排队执行的任务... | Enter a task to queue... |
| 输入提示 | Enter 添加 · Shift+Enter 换行 · Ctrl+V 粘贴图片 · Esc 关闭 | Enter to add · Shift+Enter for newline · Ctrl+V to paste an image · Esc to close |
| 状态 | 运行中 / 已暂停 / 等待空闲确认 / 等待处理 / 发送失败 | Running / Paused / Confirming idle / Action required / Send failed |
| 快捷任务 | 继续 / yes / 好的，继续 / /compact | Continue / yes / OK, continue / /compact |

## Out of scope

- 不通过 OCR、ANSI 文本、光标位置或关键字匹配推断 CLI 已完成、提示类型或错误类型。
- 不根据 `Notification(permission_prompt)`、界面当前选中项或“推荐”文案自动发送回车；不为错误自动发送 `1`、`y`、`yes` 或 `continue`。
- 不自动批准 Claude 以外 CLI 的权限请求，也不自动回答 `AskUserQuestion`、elicitation、登录或其他业务问题。
- 不把队列从已退出的 PTY 自动迁移到新启动或恢复出的另一条 PTY session，避免在错误会话中执行旧任务。
- 不增加跨设备云同步、团队共享队列、定时任务、优先级、拖拽排序或跨会话依赖编排。
- 不改动 `TerminalView` 的 xterm 渲染、休眠、恢复与输出缓冲生命周期。
- 不在 `cc-panes-web`/Docker 模式交付队列 CRUD、后台执行或无人值守。
- 不承诺 CC-Panes Rust 后端和 terminal daemon 都已退出时仍继续派发；重新启动后按持久化状态恢复并重新校验。

## Risks

- 某些 CLI 没有可靠的 TurnEnd hook，只能在 hook 与 PTY 输出都超过既有陈旧阈值后降级派发，下一项可能延迟约 30 秒。
- PTY 写入不是天然幂等的；进程在“字节已写入、成功回执尚未持久化”的窗口崩溃时无法证明是否送达，因此必须标为“等待处理”而不是自动重发。
- 无人值守会绕过 Claude 的逐次工具权限确认，属于明确的高风险 opt-in；入口必须有风险说明，默认关闭，且只在队列有待执行项目、结构化请求身份完整和写入所有权有效时生效。
- daemon 旧版本没有真实 claim 裁决时不能安全自动写入；自动派发和无人值守必须 fail closed，而不是沿用兼容性的“假定 claim 成功”。
- 图片生命周期跨越前端草稿和后台派发；实现必须使用应用自有目录、引用计数/清理规则与 canonical path 校验，避免任意路径读取和提前清理。
- 状态栏空间紧张，数量与状态必须在窄窗格中退化为图标、徽标和 Tooltip，不能挤压项目路径到重叠。

## Success criteria

- 全局开关开启时，Tauri 桌面端每个有有效 `sessionId` 且 `cliTool != none` 的可见终端状态栏都有任务队列入口；关闭后入口消失，已有队列内容不变，且关闭事务之后没有新队首被认领。
- 单个 session 可按 FIFO 保存至少 100 项；添加、删除、清空、暂停、继续、显式重试和快捷任务均有自动化测试。
- 连续 100 次模拟 `Thinking -> terminal output -> TurnEnd -> Idle` 的压力测试中，每项恰好提交一次，顺序一致，无提前提交。
- `WaitingInput`、`Error`、`Exited`、写入租约丢失、旧 daemon 无 claim、未知等待类型、新鲜 PTY 输出和后端重启无观察基线场景均为 0 次下一任务误发。
- 模拟提交失败时，队首项目仍在原位并进入“发送失败”；模拟回执不确定或进程恢复时不自动重发。显式重试会清除失败阻塞，但仍尊重用户暂停状态。
- Claude `PermissionRequest` 只有在 `tool_use_id` 非空、会话/租约有效、队列非空且用户已确认开启无人值守时才返回一次幂等的结构化 `allow`；重复请求返回同一决策，Notification、错误和未知 payload 为 0 次自动输入/批准。
- 剪贴板图片只会落入应用自有的 task-queue 图片目录；伪造引用、目录穿越、符号链接逃逸、超大或非图片数据均被拒绝。
- 老版本配置缺少新字段时正常加载并默认开启任务队列入口；新字段类型无效时只把该字段归一化为 `true`，其他设置保持原值。
- TypeScript、Vitest、Rust workspace tests 与 clippy 均通过。
- Windows 主机实测 Claude 队列连续执行 10 项无误发，并验证一个结构化 PermissionRequest 只批准一次；Codex 队列按降级门控执行 3 项且忙碌期间不提前发送。

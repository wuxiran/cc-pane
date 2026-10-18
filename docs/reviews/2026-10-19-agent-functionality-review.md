# CC-Panes Agent 功能完整性审阅

审阅基线为 `codex/fix-dev01222-audit` 的 `da2dc02d`，范围涵盖 ACP Agent Chat、终端只读 Chat、SelfChat、编排任务及任务队列。确认 **15 项实现缺陷：5 个 P1、10 个 P2**。关键缺口集中在停止与回收、审批状态、配置生效顺序、恢复和失败重试。

这份审阅不把所有未提供的功能都当成 bug；已有实现缺陷、明确的能力边界和独立分支中的未合并功能分别列出。本轮没有修改业务代码。

## 需要优先修复的实现缺陷

### A01 P1 停止或关闭 Agent 后，命令仍会继续运行

ACP 工具终端的退出监控取走 Child，kill/release/release_all 随后找不到句柄却返回成功。另一路 Unix adapter 停止仅杀本体，没有终止所属进程组。用户看到已停止，CLI 工具后代仍可能继续写文件和占用资源。两条路径需要分别修复。

代码：[acp_client_ops.rs:353](/Users/wuxiran/workspace/rust/cc-pane-audit-fixes/src-tauri/src/services/acp_client_ops.rs:353)；[acp_client_ops.rs:211](/Users/wuxiran/workspace/rust/cc-pane-audit-fixes/src-tauri/src/services/acp_client_ops.rs:211)；[acp_chat_service.rs:1157](/Users/wuxiran/workspace/rust/cc-pane-audit-fixes/src-tauri/src/services/acp_chat_service.rs:1157)。

验证：实际生产模块隔离运行：三个 terminal 清理入口后 sleep 均存活；真实 stop 调用后 fake adapter 的后代仍存活。

### A02 P1 并行工具审批会覆盖前一个请求

后端允许多个 pending_permissions，前端只有一个 pendingPermission。先收到 A、再收到 B 时 A 被覆盖；答完 B 后界面为空，但 A 仍在后端等待，回合无法自然结束。应将审批按 requestKey 排队或并列展示。

代码：[useAgentChatStore.ts:314](/Users/wuxiran/workspace/rust/cc-pane-audit-fixes/web/stores/useAgentChatStore.ts:314)；[AgentChatTabContent.tsx:414](/Users/wuxiran/workspace/rust/cc-pane-audit-fixes/web/components/agentchat/AgentChatTabContent.tsx:414)。

验证：真实 Zustand store 探针复现 A→B→回答 B 后无 A 的可操作状态。

### A03 P1 首条任务没有等待选定模式生效

启动页将 setMode、setModel、setConfigOption 异步发出后立即发送首条 prompt。选择 plan 等限制模式时，配置仍未完成或已失败，任务就可能按引擎默认模式开始。模式配置失败需要明确阻断首轮。

代码：[EnginePicker.tsx:200](/Users/wuxiran/workspace/rust/cc-pane-audit-fixes/web/components/agentchat/EnginePicker.tsx:200)；[EnginePicker.tsx:227](/Users/wuxiran/workspace/rust/cc-pane-audit-fixes/web/components/agentchat/EnginePicker.tsx:227)。

验证：真实 React 组件探针：setMode 保持 pending 时已经调用 prompt；未运行真实 CLI 验证权限后果。

### A04 P1 切换项目失败后，显示目录与实际执行目录不一致

选择已删除或卸载的工作空间目录时，前端先更新 cwdOverride 并显示已切换，失败后不回滚。后端在停止旧会话前验证新目录，因此旧会话保持 ready；下一条任务实际仍在旧项目运行。

代码：[SessionWorkspaceMenu.tsx:46](/Users/wuxiran/workspace/rust/cc-pane-audit-fixes/web/components/agentchat/SessionWorkspaceMenu.tsx:46)；[acp_chat_service.rs:492](/Users/wuxiran/workspace/rust/cc-pane-audit-fixes/src-tauri/src/services/acp_chat_service.rs:492)。

验证：React 探针确认新 cwdOverride 与旧 ready/acpSessionId 同时存在，并核对后端验证顺序。

### A05 P1 协作消息会被注入正在等待确认的终端

报告和指令投递把 WaitingInput 当成 Idle，自动写入文本及回车；该状态也代表 permission_prompt 和 elicitation_dialog。消息可能进入审批或问答控件，并被错误标为 delivered。这里确认的是投递路径会干扰确认界面，不能据此声称已实机绕过授权。

代码：[orchestrator_service.rs:12916](/Users/wuxiran/workspace/rust/cc-pane-audit-fixes/src-tauri/src/services/orchestrator_service.rs:12916)；[orchestrator_service.rs:14221](/Users/wuxiran/workspace/rust/cc-pane-audit-fixes/src-tauri/src/services/orchestrator_service.rs:14221)；[claude.rs:112](/Users/wuxiran/workspace/rust/cc-pane-audit-fixes/cc-cli-adapters/src/claude.rs:112)。

验证：代码路径核实；对照任务队列正确阻塞 WaitingInput 的实现。

### A06 P2 临时查询错误可永久堵住任务队列

claim_next 已把队首改为 Dispatching 后，第二次 readiness 查询报错直接返回，没有释放 claim。后续扫描返回 Noop，重试和删除也拒绝该状态；当前 recover_inflight 仅在 worker 启动时运行。

代码：[task_queue_dispatcher.rs:148](/Users/wuxiran/workspace/rust/cc-pane-audit-fixes/cc-panes-core/src/services/task_queue_dispatcher.rs:148)。

验证：实际 dispatcher + 假 gateway 注入一次查询错误，复现 Dispatching、后续 Noop、retry/delete 拒绝。

### A07 P2 图片任务在 CLI 读取前就清理了附件

提交成功只代表文本已经写入 PTY，complete_claim 却立即删除图片；prompt 里保存的是图片路径。异步读取路径的 CLI 会拿不到图片，而队列项已被移除。应在消费确认或可靠保留期之后清理。

代码：[task_queue_service.rs:196](/Users/wuxiran/workspace/rust/cc-pane-audit-fixes/cc-panes-core/src/services/task_queue_service.rs:196)。

验证：实际队列模块复现：submit 返回后，捕获的 prompt 图片路径已不存在，队列已空；未声称每个真实 CLI 都必然遇到相同时序。

### A08 P2 重试编排任务会丢失原执行配置及跟踪身份

重试直接创建普通终端，只传 project/workspace/cliTool，丢弃 dispatchEnvelope 中的 runtime、profile、cwd、model、permissionMode。新 binding 也没有信封，后续 get_task_status 会返回 not a dispatch_task binding。

代码：[OrchestratorTaskActions.tsx:184](/Users/wuxiran/workspace/rust/cc-pane-audit-fixes/web/components/sidebar/OrchestratorTaskActions.tsx:184)；[orchestrator_service.rs:7211](/Users/wuxiran/workspace/rust/cc-pane-audit-fixes/src-tauri/src/services/orchestrator_service.rs:7211)。

验证：执行从当前源码提取的 retryTask 回调，服务替换为记录参数的 stub，确认配置及派发信封丢失。

### A09 P2 SelfChat 的结束按钮会再创建一个 Agent

结束会话后清空 activeSession，并把自动启动标记重置为 false；仍挂载的组件立即进入自动启动 effect，无法真正停留在结束状态。

代码：[SelfChatManager.tsx:101](/Users/wuxiran/workspace/rust/cc-pane-audit-fixes/web/components/selfchat/SelfChatManager.tsx:101)；[SelfChatManager.tsx:45](/Users/wuxiran/workspace/rust/cc-pane-audit-fixes/web/components/selfchat/SelfChatManager.tsx:45)。

验证：运行现有 12 项组件测试，其中一项明确断言结束后自动新建，说明现有测试固定了这个产品行为。

### A10 P2 重新启动并恢复会话会重复追加历史

同一 chatId 的旧 items 没有清理或去重，session/load 全量回放继续追加到旧数组。一次重启即可出现重复消息，重复重启继续累积。

代码：[AgentChatTabContent.tsx:203](/Users/wuxiran/workspace/rust/cc-pane-audit-fixes/web/components/agentchat/AgentChatTabContent.tsx:203)；[useAgentChatStore.ts:128](/Users/wuxiran/workspace/rust/cc-pane-audit-fixes/web/stores/useAgentChatStore.ts:128)。

验证：实际 store 探针确认重放后原用户与助手消息各出现两次。

### A11 P2 重试上一轮会丢弃图片和文件引用

重试只重新发送最后一条非空 user.text，不带原 image/resource_link。纯附件任务还可能回退到更早的文字消息，或没有重试按钮。

代码：[ChatComposer.tsx:239](/Users/wuxiran/workspace/rust/cc-pane-audit-fixes/web/components/agentchat/ChatComposer.tsx:239)。

验证：React 探针确认图文消息重试只发送 text block。

### A12 P2 Agent 写文件会改变权限及软链接语义

fs/write_text_file 使用新临时文件覆盖目标，没有保留权限和目标链接关系。实际修改后可执行脚本从 0755 变为 0644；软链接变成普通文件，真正的 target 文件内容不变。

代码：[acp_client_ops.rs:116](/Users/wuxiran/workspace/rust/cc-pane-audit-fixes/src-tauri/src/services/acp_client_ops.rs:116)。

验证：实际文件操作模块在隔离目录中复现权限和软链接两种情况。

### A13 P2 续接会话丢失用户手改标题的保护

恢复时重建元数据只保留 title，漏掉 titleSource=user。下一条 agent 标题事件会把用户命名覆盖，违反已有标题保护契约。

代码：[acp_chat_service.rs:1231](/Users/wuxiran/workspace/rust/cc-pane-audit-fixes/src-tauri/src/services/acp_chat_service.rs:1231)；[acp_chat_service.rs:1677](/Users/wuxiran/workspace/rust/cc-pane-audit-fixes/src-tauri/src/services/acp_chat_service.rs:1677)。

验证：真实服务调用 start→rename→stop→resume→标题通知，确认用户标题被覆盖。

### A14 P2 特殊文件名的附件引用指向错误路径

toFileUri 直接拼接路径，没有对 #、?、% 等 URI 保留字符编码。/workspace/notes#v2.md 被解析成 /workspace/notes，a%20b.md 被解析成 a b.md；文件选择器和 @ 引用都使用该函数。

代码：[chatPaths.ts:13](/Users/wuxiran/workspace/rust/cc-pane-audit-fixes/web/components/agentchat/chatPaths.ts:13)；[ChatComposer.tsx:179](/Users/wuxiran/workspace/rust/cc-pane-audit-fixes/web/components/agentchat/ChatComposer.tsx:179)。

验证：直接调用生产 TS 模块，再以标准 fileURLToPath 解析，三个样例均不等于原路径。

### A15 P2 大小写敏感文件系统上不能切换仅大小写不同的项目

samePath 无条件小写化，/workspace/App 和 /workspace/app 被视为相同；SessionWorkspaceMenu 据此直接跳过切换，历史本项目筛选也会混在一起。适用 Linux 或大小写敏感卷，不把它泛化到默认大小写不敏感的文件系统。

代码：[chatPaths.ts:19](/Users/wuxiran/workspace/rust/cc-pane-audit-fixes/web/components/agentchat/chatPaths.ts:19)；[SessionWorkspaceMenu.tsx:30](/Users/wuxiran/workspace/rust/cc-pane-audit-fixes/web/components/agentchat/SessionWorkspaceMenu.tsx:30)。

验证：实际纯函数探针返回 true，并核实工作空间切换的提前返回条件；未做 Linux 桌面实机验证。

## 当前能力边界与未完成部分

- **消息正文没有本地持久化兜底。** 当前只持久化会话元数据，正文留在内存；恢复依赖 adapter 的 session/load。引擎不支持或加载失败时会提示降级新会话，应用自身无法还原原消息。见 [设计说明第 8 节](../94-acp-agent-chat.md#8-已知未做)。
- **改动审查不是完整的文件检查点。** ChatChangesPanel 仅聚合 agent 上报的 diff，不扫描实际磁盘；未上报的修改看不到，也没有在此工作流中提供检查点回滚或逐项接受/撤销。
- **终端里的 Chat 是只读回看。** AgentChatView 与可交互的 ACP Agent Chat 是两个入口，前者不能直接继续发消息。Web 版 ACP Agent Chat 明确不支持。这些是当前产品边界，不是偶发按钮失灵。
- **多题问答向导、应用自己的消息恢复兜底仍被文档列为未做。** 不能仅凭多引擎入口、工具卡和审批卡存在，就认为完整 agent 工作流已交付。

## 其他工作树的功能状态

本次审阅时，`codex/feat-agent-chat-timeline` 已有提交 `94c6a144`（时间线导航与书签），但该提交不在当前审阅分支中。`codex/feat-chat-fork` 有新版分叉的未提交修改，包括 capability 检查和 session/fork 调用；当前审阅版本的“在新标签继续”仍使用 session/load。未合并功能不计入上述 15 项缺陷，也不能当成当前版本已具备。

## 验证范围与修复顺序

前端实际组件/store 的 5 个隔离探针复现了 A02、A03、A04、A10、A11。后端通过直接引用生产 Rust 模块及 fake ACP adapter 验证了 A01、A12、A13。任务队列、重试回调和 SelfChat 验证覆盖 A06 至 A09；A05 为代码路径核实。路径探针覆盖 A14、A15。探针中“通过”表示观察到了所述缺陷，不表示功能正确或问题已修复。

所有测试使用隔离目录、模拟 IPC 或 fake adapter，没有运行真实 Agent CLI、联网聊天或操作用户会话；探针子进程均已回收。Windows 原生行为不在本机验证结论内。证据位于 `/Users/wuxiran/Documents/ChatGPT/ccpane/agent-review-evidence/2026-10-19`。

建议先处理 A01 至 A05，再补齐队列恢复与完整重试（A06 至 A11），随后修复文件和历史元数据语义（A12 至 A15）。功能建设优先考虑消息持久化及恢复，再整合时间线和真正的分叉流程；已有回归测试需改为验证正确产品行为，而非继续固定当前断路。

# Grok 长会话回看（批次 1 · 已收尾）

> 背景：Grok 全屏 TUI 走 native alt-screen（docs/73 定案），备用屏无 scrollback，
> 长对话/plan 在窗格里不可回看。完整对话只存在于 Grok 落盘的
> `~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/chat_history.jsonl`。
> 方案对齐 Orca Native Chat 的读侧思路（`references/orca`：`grok-session-paths.ts`、
> `transcript-line-decoders-grok.ts`）。

## 执行过程（2026-08-29）

原计划是先做「导出 Markdown」止血。开工时发现**工作区已有另一实例（Grok 会话
aec5e941，停在 18:19）做到一半的完整实现**——只读对话回看视图 + ACP 原生对话，
未提交、未编译通过。按多实例纪律改为接管收尾而非另起炉灶。

### 在途实现的构成（接管时已存在）

- Rust：`cc-panes-core/src/services/agent_transcript/`（grok 路径解析 + 行解码 +
  分页，10 个单测）、`read_agent_transcript_cmd` command
- Rust：`src-tauri/src/services/acp_chat_service.rs`（ACP 子进程会话，799 行）+
  `acp_chat_commands.rs`，lib.rs 全部注册
- 前端：`AgentChatView.tsx`（终端内 Terminal⇄Chat 只读回看，分页「加载更早」）、
  `TerminalStatusBar` 双态切换 + 状态栏隐藏时浮动入口、
  `agentchat/`（ACP 对话标签：气泡/工具卡/审批卡）、`useAgentChatStore`、
  新 contentType `"agent-chat"`（tabContentType 两表已同步）、tabLifecycle 登记

### 本次收尾修复

1. 4 个 TS 错误：i18n 键类型收窄（去掉 `: string` 注解让字面量联合推导）；
   `AcpSessionUpdate.content` 的**交叉类型改 union**（chunk 单块 / tool_call 数组
   两形态，消费点 `Array.isArray` 收窄）
2. 1 个 clippy：`resolve_grok_chat_history_path_sync` 手写循环改 `Iterator::find`
3. 设计 token 守护：`agentchat/` 三个组件的硬编码色类全部换 `--app-status-*` 语义 token
4. 行数棘轮：`TerminalTabContent.tsx` 554→361 行——抽出 `TerminalLeafPanels.tsx`
   （RestoreLogSurface / BlockedRestorePanel / LaunchErrorPanel，183 行）
5. 会话级资源守护：`useAgentChatStore` 登记豁免（按 chatId=tabId 键控），并**修了
   真实泄漏**——agent-chat 标签关闭现在会 `dropAgentChatState`（消息流 + chunk 缓冲）

### 门禁结果

- `npx tsc --noEmit` ✅ / 前端全量 479 文件 4619 测试 ✅
- `cargo check --workspace` ✅ / `cargo clippy --workspace -- -D warnings` ✅
- `cargo test --workspace`：1401 过 / 1 失败（`pty::job` 进程树测试，本次零改动、
  单跑即过，判定为全量并行时的环境干扰）

## 已知边界（批次 2 候选）

- WSL 里跑的 grok：transcript 只解析本机 `~/.grok`，WSL 会话回看会报 NotFound
- claude / codex 的 transcript decoder（read_agent_transcript 已留 UnsupportedCli 口）
- 「导出对话为 Markdown」右键动作（回看视图已覆盖主诉求，导出降级为 nice-to-have）
- agent-chat 关闭确认（generating 中关闭无拦截，registry 注释已标注）

## 后续发现（2026-08-30，会话 af5f77fa 复诊）

- ctl `sessions read` 头部披露：活会话 daemon 保留上限 **2 万行 / 20MiB**——实测该会话
  全量输出仅 733KB，**daemon 手里是完整的**。前端滚不动是因为画面重建（隐藏积压溢出 /
  desync）只用「当前屏 photo + 增量」，没消费 daemon 的完整保留流。
- **修复新路径（比 checkpoint 转正更便宜）**：重建时若 daemon 保留流未触上限，
  全量回放（过 renderTerminalData）替代 photo+delta，scrollback 直接复原。
  触上限的超长会话再降级 photo+delta + 截断提示。
- 老会话（配置生效前创建）resume 时按原模式重开（"Reopening session in X mode"），
  全局 screen_mode 对它们无效——只有新会话吃到 fullscreen。

## 后续修复（2026-08-31，「重置终端缓冲区」去破坏化）

用户实测锁定死亡链条：后台切回画面坏 → 被迫点「重置终端缓冲区」→ 历史全灭。
断点在重置实现：裸 `xterm.reset()` 清空 scrollback 后靠 SIGWINCH 等 CLI 重画，
而 **inline CLI（grok）只补画底部活动区，历史归终端保管、永远不会重画**。

修复：重置动作优先复用 desync 恢复器（闸门 → photo+delta 快照重建 → 放行积压，
回滚历史随快照恢复），快照不可得（会话已死/旧 daemon/web 降级）才回退裸 reset。
`createTerminalDesyncHandler` 返回成败布尔供菜单决策；确认弹窗文案同步改写。
新增 4 个 hook 用例 + resync 返回值断言。

遗留：「后台切回画面变坏」的根因（bug A）尚未采到活体——现在代价已从
「历史全灭」降为「点一次重置即恢复」；下次复现先别重置，采现场。

## 关联发现（另案）

- `mcp-orchestrator.json` 会丢失且 orchestrator 不自愈（只在启动时写一次）——
  本次已手工重建救回，代码级自愈值得单独排

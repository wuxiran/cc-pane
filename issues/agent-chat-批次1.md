> **已过时（2026-08-30）**：批次 1-D 与对标 Orca 的补齐已全部落地并提交
> （`8d87e23d` / `296c8610`，底座在 `e96ad412`）。当前事实源见
> `docs/94-acp-agent-chat.md`；剩余未做项见该文 §8。本文仅存档。

# Agent Chat（ACP 对话标签）批次 1（2026-08-29）

## 上下文

在 CC-Panes 里做 Cursor 式 agent 对话。方向决策（对话中拍板）：

- **形态**：pane 标签类型 `agent-chat`（不是全屏主视图），保留分屏、可开多个、与终端混排
- **协议**：ACP（Agent Client Protocol）当引擎无关层——2026 年已是行业标准，claude/codex/grok/gemini/qwen/opencode 全有 ACP 出口
- **引擎**：现成适配器，不自研 agent loop；pi 后置为将来的引擎之一
- **进程归属**：app 进程（非 PTY、不进 daemon），app 重启断会话，恢复靠批次 2 的 `session/load`

## 已落地（批次 1）

### Rust（src-tauri）

| 文件 | 内容 |
|------|------|
| `services/acp_chat_service.rs` | 多会话 ndjson JSON-RPC 客户端：spawn（cwd 校验 + Job Object 防孤儿 + env_remove CLAUDECODE）、initialize/session-new 握手（180s 超时，容 npx 首次下载）、prompt（异步回合，`turn_ended` 事件收尾）、cancel（含 pending 审批按 spec 回 cancelled）、respond_permission、stop/cleanup_all；`session/update` 原样透传，未知方法回 -32601，未知通知以 `notification` 事件可见 |
| `services/process_guard.rs` | 新增 `attach_raw_handle`（Windows）/ `attach_pid`（Unix），适配 tokio Child |
| `commands/acp_chat_commands.rs` | 引擎注册表（**版本 pin**：claude-agent-acp@0.70.0、codex-acp@1.7.0、grok 原生）+ 7 个命令；解析走 `resolve_executable` + `rewrite_windows_npm_shim` |
| `Cargo.toml` | tokio 加 `process`/`io-util` 特性 |
| `lib.rs` | manage + invoke_handler + 退出 cleanup_all |

事件：`acp-chat-event`，信封 `{chatId, kind, payload}`，kind ∈ state / update / permission_request / turn_ended / notification / protocol_noise。

### 前端（web）

| 文件 | 内容 |
|------|------|
| `types/agentChat.ts` | ACP v1 子集镜像 + 渲染条目模型 |
| `services/agentChatService.ts` | invoke 封装 + listen |
| `stores/useAgentChatStore.ts` | 消息归约（tool_call 按 id 就地合并、plan 整表替换、未知变体去重提示）+ **chunk 16ms 合批**（防 token 流渲染风暴），事件桥幂等启动 |
| `components/agentchat/` | `AgentChatTabContent`（引擎选择页 + 消息流 + composer + 自动吸底）、`ToolCallCard`（折叠卡 + diff/content 渲染）、`PermissionCard`（选项由 agent 给出） |
| contentType 接入 | `terminal.ts` 联合 + `tabContentType.ts` 两张表（归 terminal 桶、MessagesSquare 图标）+ `registry.ts` TAB_LIFECYCLE（onClosed 停进程，未挂载路径可达）+ `paneSessions.ts` 分桶 + `TabContentRenderer` + `NewTabMenu`/`useNewTabActions`/`Panel` 新建入口 + i18n 中英 |

### 验证

- `cargo check -p cc-panes` ✅；`cargo test -p cc-panes --lib acp` ✅（2/2）
- 穷举纪律测试 ✅（tabContentType/registry/destroyPipeline/killSessionAllowlist 69/69）
- store 归约测试 ✅（7/7，`useAgentChatStore.test.ts`）
- **真实握手冒烟 ✅**（`tmp/acp-smoke.cjs`）：initialize→session/new 成功，protocolVersion 1，claude 登录态直接可用

### 冒烟带回的两个情报

1. **claude-agent-acp 默认 `bypassPermissions` 模式**——默认不发审批请求（等效 yolo）。审批卡已实现，切到 `default` 模式即生效；**模式选择器（session/set_mode，auto/default/acceptEdits/plan/dontAsk）应加进批次 2**。
2. **`loadSession: true` 且 sessionCapabilities 带 resume/fork/list**——批次 2 的会话恢复路线畅通。

## 未尽 / 阻塞

- 全仓 `tsc` 与 `clippy --workspace` 被**并行 worker**（agent_transcript 只读 Chat 视图，用户派的另一会话）的在途代码挡住：其 `AgentChatView.tsx` 2 个 t() 类型错、`grok.rs` 1 个 manual_find lint。我方文件在两个检查里均无报错。**worker 收工后需补跑全仓四件套。**
- 关闭 generating 中的 chat 无确认（closeGuards 空）——批次 2 与持久化一起补
- 侧栏项目右键「新建 Agent 对话」入口未加（+ 菜单入口已有）
- 真机 UI 验证未做（需 `npm run tauri:dev`，当时避免与用户实测/并行 worker 冲突）

## 批次 2 计划（未动工）

模式选择器、审批流真机验证、会话持久化（SQLite 行 + 事件 JSONL 重放 + session/load）、TUI↔Chat 互转（与并行 worker 的 transcript 读取器汇合）、关闭确认、侧栏入口。

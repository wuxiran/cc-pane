# 94 · ACP Agent Chat：结构化 agent 对话标签

> 状态：已落地（0.12.10 开发线）。本文是设计决策与排障判据的单一事实源；
> 操作层面见引擎清单与自定义配置一节。

## 1. 是什么

`agent-chat` 是第 9 种 pane 标签类型：Cursor 式的结构化 agent 对话（流式
Markdown 气泡、工具调用卡、审批/提问卡、plan 面板、diff 内联），背后引擎
是用户已装的 CLI（claude/codex/grok/gemini/…），经 **ACP（Agent Client
Protocol，Zed 系标准）** 通信。与终端标签是并列关系，不替代 TUI。

同族但不同物：`AgentChatView`（终端标签内的 Terminal⇄Chat 切换视图）是
**只读 transcript 回看**（读 CLI 落盘的 jsonl），与本文的活会话标签是两条
轨道，注意区分。

## 2. 为什么选 ACP（决策记录）

- docs/55 H3 曾判「Native Chat 第二渲染管线不做」，理由是会产生第二套消息
  协议、审批 UI 和适配矩阵。**ACP 把这三样全部外部化了**：协议是行业标准
  （v1 稳定，v2 draft 于 2026-07 发布）、适配器由 agentclientprotocol org
  维护、审批/plan/diff 都在 spec 里。判定的前提消失，故重启。
- 订阅经济学：claude-agent-acp 包官方 Agent SDK，走 `claude login` 凭据，
  订阅额度可用（对比 pi 魔改路线要走 API key 计费）。
- 撤退成本被刻意压低：ACP 同时是内部 schema。若适配器生态死亡，替换面只有
  「引擎桥」一层（自写 stream-json→ACP 映射器），前端与 Rust client 不动。

## 3. 架构

```
Chat UI (React) ←acp-chat-event← AcpChatService (src-tauri, ndjson JSON-RPC)
                                     │ spawn（Job Object 防孤儿）
                                     ▼
                     适配器进程（claude-agent-acp 等）→ CLI 运行时
```

- **app 进程内、非 PTY、不进 daemon**：不触碰 boundary_events 契约面。app
  重启即断进程，续接走 `session/load`（见 §5）。web 模式（cc-panes-web）
  不支持，桌面 only。
- 事件信封 `{chatId, kind, payload}`，kind ∈ state / update /
  permission_request / turn_ended / notification / protocol_noise。
  `session/update` 的 params **原样透传**，未知变体前端降级可见（notice
  去重提示）——这是 v1→v2 过渡期的协议漂移探针，不许静默丢弃。
- token 流防渲染风暴：`agent_message_chunk` 在监听层 16ms 合批再进
  Zustand（`useAgentChatStore` 的 chunkBuffers），非 chunk 事件先排空缓冲
  保序。xterm 输出洪水的同族问题，同族治法。
- 关键 id 语义：`chatId` = tab id（运行时身份）；`acpSessionId` = 对话的
  稳定身份（历史 meta 按它落盘）。**不要混用**——docs/69 的 launch id 教训
  在这里的对应物。

## 4. 引擎注册表与自定义

内置 11 家（`acp_chat_commands.rs::ACP_ENGINES`）：claude/codex/pi 走 npx
桥接包（**版本 pin**，防远端发布改协议），grok/gemini/qwen/opencode/
copilot/cursor-agent/kimi/openclaw 走各自原生 ACP 出口。列表按已安装优先
排序。

自定义逃生阀：`<data>/agent-chats/engines.json` 放数组
`[{id,label,executable,args,requirement?}]`，与内置合并（同 id 内置优先，
坏文件忽略并落日志）。ACP 注册表 40+ 家全部可由此接入，硬编码大表是
Orca 架构的必要之恶，不是我们的（docs/55 H6 数量竞赛不追的延续）。

## 5. 会话生命周期

- 握手：initialize（记录协商 `protocolVersion` 进快照，v2 分叉依据）→
  有 resume id 且 agent 广告 `loadSession` 时走 `session/load`（agent 全量
  回放历史成 update 流），否则 `session/new`。**load 失败降级新会话必须可
  见**（notice），resume 链路静默降级的老教训。
- 历史：每个对话按 acpSessionId 落一个 meta JSON（engine/cwd/title/时间），
  引擎选择页列出可筛选、可续接。消息本体不落盘——回放靠协议。标题三来源
  （meta 的 `titleSource`）：`auto` = 首条 prompt 截 60 字；`agent` = 引擎经
  `session_info_update` 给的（claude/codex/copilot/cursor 实测首轮后发一次，
  覆盖 auto）；`user` = 手改，agent 不得覆盖，清空即放弃手改。前端收到
  `session_info_update` 时派发 `ccpanes:agent-chat-history-changed` 让侧栏即时重拉。
- 分叉：新标签 + `session/load` 同一 acpSessionId（claude 的 resume 语义
  天然分叉）。
- 回收：关标签走 `TAB_LIFECYCLE["agent-chat"].onClosed`（组件未挂载路径可
  达），generating 中关闭有 closeGuard 确认。

## 6. MCP 注入（差异项）

`session/new`/`load` 的 `mcpServers` 注入 ccpanes orchestrator MCP（http
形态，URL 从 orchestrator manifest 直读，按 agent 的 `mcpCapabilities`
过滤）。Chat 里的 agent 因此能派工/开终端/查会话。注意：当前 URL 不带
launchId，leader 语义类工具不可用；串台 gotcha（CLAUDE.md agent 实例身份
那条）对 chat 同样适用。

## 6.1 权限自动放行（按 ToolKind 多选）与引擎实测矩阵

用户在 composer 的「权限」下拉按类勾选（读取与搜索 / 编辑文件 / 执行命令 /
网络访问 / 其他工具 / 全部），展开成 ACP ToolKind 集合交后端；后端对每个
`session/request_permission` 做三级 kind 解析后匹配：**请求自带 `toolCall.kind`
→ 同 `toolCallId` 在 `tool_call` 流里报过的 kind（有界缓存）→ 标题前缀推断**
（`infer_tool_kind_from_title`，白名单外归 other）。选项挑选规则：按类放行只在
**恰好一个 `allow_once`** 时代答（Cursor AskQuestion / Codex 沙箱权限档是 N 个
allow_once 并列 = 提问，不能替用户乱选）；通配 `*`（Automations）保留「必推进」。
代答后 emit `ccpanes/auto-approved`（带 `resolvedKind`），前端进消息流留痕。

引擎实测（0.12.10，探针 `tmp/acp-perm-probe.cjs`：真机起会话跑读/搜/执行/写/改/联网，
记录权限请求原始 payload；跑不起来的按源码或本地 bundle 核对）：

| 引擎 | 权限请求带 kind | 备注 | usage_update |
|---|---|---|---|
| claude | 是（真机） | 实测 edit/fetch；`echo` 在 default 模式不弹。**本机若 `~/.claude/settings.json` 是 bypassPermissions + allow 全量，ACP set_mode 压不过它，永远不弹** | 是 |
| codex | 是（源码） | 命令联网归 **execute**（不是 fetch）；MCP 工具审批归 execute；沙箱权限档 kind=other 且多 allow_once → 不代答 | 是 |
| copilot | 是（真机） | execute/edit/fetch | 否 |
| opencode | 是（真机） | 默认配置不问权限，需 `permission: {edit/bash/webfetch: "ask"}`；`OPENCODE_CONFIG` 会整体替换配置（provider 丢失→挂死），项目级 `opencode.json` 才是合并 | 看 provider |
| grok | 从不弹权限（真机） | 6 类工具全自动执行；其 `x.ai/hooks` pre_tool_use 是另一套机制 | 否 |
| gemini / qwen | 是（源码） | `toAcpToolKind` 全映射 | 否 / 是 |
| cursor | 是（本地 bundle） | Write/Delete→edit, Shell→execute, MCP→other, AskQuestion→other（多选） | 否 |
| **kimi** | **否**（源码） | tool_call 与权限请求都无 kind，标题 `Shell: …`/`WriteFile: …`/`StrReplaceFile: …`，靠标题推断兜底 | 否 |
| openclaw | 是（源码） | 只转发命令审批，恒 execute（需本机 gateway） | 否 |
| pi | 是（源码） | 仅扩展 UI 提问走 request_permission，恒 other | 否 |

## 6.2 协议覆盖面（0.12.10 补齐批次）

| 面 | 状态 | 落点 |
|---|---|---|
| `configOptions` / `session/set_config_option` / `config_option_update` | ✅ | 快照 `configOptions` 整表透传（`session/new` 响应、set 响应、通知三处替换；mode/model 类别镜像进 legacy `modes`/`models`，反向亦然）。composer 经 `ConfigOptionSelectors` 渲染 select 类，legacy 选择器已占的类别去重；`thought_level` 显示为「思维深度」。偏好按 configId 记进 `enginePrefs.preferredConfigOptions`，启动后对仍广告的项自动应用。**注意** claude-agent-acp #714：set 成功后不发通知，所以以响应体为准。 |
| 客户端 `fs/read_text_file` / `fs/write_text_file` | ✅ | `acp_client_ops.rs`；绝对路径、`line`/`limit` 窗口、写入走临时文件 + rename。`clientCapabilities.fs` 两项已广告 true。 |
| 客户端 `terminal/create|output|wait_for_exit|kill|release` | ✅ | `acp_client_ops::AcpTerminalManager`：每 terminalId 一个子进程（Job/进程组守卫），stdout+stderr 合并进有界缓冲（`outputByteLimit`，上限 4MB，从前截断到 UTF-8 边界），退出码进 `exitStatus`；输出去抖 80ms 经 `terminal_output` 事件推前端，`ToolCallCard` 的 `{type:"terminal"}` 块按 terminalId 订阅实时渲染。会话结束 `release_all`。请求在读循环外 spawn 处理——`wait_for_exit` 会阻塞。 |
| `authenticate` | ✅ | `session/new` 回 `-32000 auth_required` 时按 `initialize.authMethods` 逐个 `authenticate` 再重试一次；都不成功则 `ACP_AUTH_REQUIRED` 带方法名列表报给用户（交互式登录仍需在终端完成）。 |
| `promptCapabilities.image` 门控 | ✅ | composer 只在 agent 广告 `image: true` 时内嵌图片；有路径的图片转 `resource_link`，粘贴/拖放的丢弃并 notice。 |
| `session/list` / `session/fork` / `session/resume` / `session/close` | ⏳ | v2 / unstable，等适配器跟进（§7 v2 适配时机）。 |

## 7. 排障判据

- **引擎绿点 ≠ 可用**：npx 型引擎的 available 只代表 npm 在；底层 CLI 未
  登录会在握手失败信息里带出 stderr 尾巴（`ACP_HANDSHAKE_FAILED`）。
- **gemini 报 unknown option**：老版本开关叫 `--experimental-acp`，升级
  gemini 或用 engines.json 覆写 args。
- **恢复出的会话是空的**：看是否出现「未能续接」notice——引擎不广告
  loadSession（或 load 被拒）时属预期降级，不是丢数据。
- **审批卡不出现**：先看 composer 权限下拉是否勾了该类（会有「已自动放行」
  留痕）；claude 还要看 `~/.claude/settings.json`——`defaultMode:
  bypassPermissions` + allow 列表会让 ACP 的 set_mode 失效，永远不弹（§6.1）。
- **v2 适配时机**：等 claude-agent-acp 发布 v2 支持；改动面 =
  `session/load`→`session/resume`（replayFrom 游标）+ 历史列表换协议原生
  `session/list`。快照里的 `protocolVersion` 是分叉依据。

## 8. 已知未做

多题问答向导（ACP v1 无对应形状，等 v2；usage 已由 `usage_update` RFD 落地，
composer 右下用量环，仅 claude/codex/qwen/opencode 上报）；消息本地落盘兜底
（`acp_chat_service` 只落会话元数据——重命名/删除/列表——不存消息正文，非
loadSession 引擎恢复后画面为空）；N10 跨 CLI 会话索引与 N3b 额度展示是独立战场
（docs/83）。

> 2026-09 核对已划掉两条：语音输入已由 `ChatVoiceButton` 落地（与终端麦克风共用
> `lib/voiceAudio`，经 `useVoiceInputStore` 互斥）；`@` 引用已有文件 picker
> （`ChatComposer` 接 `openFileDialog`，图片/文件附件 + `resource_link` 组装）。

# 112 · iOS 原生客户端 + Bot 组网

> 状态：P1（终端镜像）、P2 iOS 侧（对话 UI，mock 验证）已完成；P2 后端桥、P3 配对/地址簿进行中；P4 Bot 组网后端 + 桌面 UI 已落地（§5）。
> 前置阅读：docs/94（ACP Agent Chat）、docs/111（多设备：设备令牌与配对码）、`src-tauri/src/services/bot_service.rs`（Bot 联系人）。
> 代码与构建：`cc-panes-ios/README.md`。参考：t3code 移动端（序号续传、审批卡停靠、后台策略）。

## 1. 定位

- **手机 = 只看不跑的节点**：CLI / ACP agent / Bot 都跑在电脑上（要读写仓库，iOS 跑不了 npx/claude），手机经电脑端 API 看、说、批。
- **每台电脑 = 一个 CC-Panes 节点**，各自养 Bot；节点之间经 docs/111 的设备令牌互联，组成 **Bot 网络**。
- **通讯录 = 全网 Bot 的并集**：手机和任一台电脑都能看到、对话所有已配对设备上的 Bot。
- 唯一不经电脑的例外：手机「直连大模型」（P6，§6），纯对话、不碰代码。

## 2. 分期

| 期 | 内容 | 状态 |
|----|------|------|
| P1 | 终端镜像：布局镜像首页、工作区启动、终端（`endSeq` 续传、desync 原地重同步、适配尺寸、屏蔽查询自动应答） | ✅ |
| P2 | **ACP 移动桥**：`/api/acp/*` + `/ws/acp/{chatId}`，手机与桌面 Agent Chat 双向同一份 | iOS ✅（mock）/ 后端进行中 |
| P3 | **配对 + 电脑地址簿**：手机复用 docs/111 配对码换 `ccp_dev_` 令牌（Keychain），多台电脑保存/切换/在线状态；Tailscale / 局域网地址 | 进行中 |
| P4 | **Bot 组网**：跨设备 Bot 目录、人→远程 Bot、Bot→Bot（MCP 工具）、按 Bot 的远程权限策略 | 后端 + 桌面 ✅（双机实测待做） |
| P5 | 推送 / 灵动岛（审批、完成）、在线状态续租 | 待做 |
| P6 | 手机直连大模型 API（Keychain 存 key，与 ACP 共用对话 UI）+ 从桌面导入供应商（§6） | ✅（mock + 本机 dev E2E） |

## 3. P2：ACP 移动桥

### 3.1 拓扑

```
iPhone / 其他电脑 ──REST/WS──▶ cc-panes-web (/api/acp/*, /ws/acp/{chatId})
                                 │ 鉴权：Cookie 或设备令牌（docs/111）；读 mcp-orchestrator.json 反向代理
                                 ▼
                      桌面 app 内 orchestrator HTTP（/acp/*，Bearer = orchestrator token）
                                 ▼
                      AcpChatService（唯一属主；桌面标签、Bot、IM 入站同源）
```

- ACP 会话只有一个属主（app 进程）。web 只做鉴权 + 透传，不持有状态。app 未运行 → 503 `{code:"ACP_HOST_UNAVAILABLE"}`。
- Bot 的对话就是 `chatId = bot-{id}` 的 ACP chat，天然出现在 `/api/acp/chats`。

### 3.2 事件环

`AcpChatService` 每次 emit（含 Bot 的 in-process event tap 那条路径）先写**每 chat 内存环**再广播：

- per-chat 单调 `seq`（从 1 起）；容量按条数+字节双上限（建议 4000 条 / 8 MB），头部裁剪；
  `floorSeq` = **环内保留的最小 seq**（不是已裁掉的最后一条）。
- **用户 prompt 也入环**：任何入口（桌面、手机、Bot 外部提交、IM）发送 prompt 时写一条
  `kind:"user_prompt"`，payload `{promptId, blocks, origin:"desktop"|"mobile"|"device:<name>"|"im"|"bot:<id>"}`。
  桌面前端已有的本地插入不变（按 promptId 去重）；iOS 已按 promptId 抵消本地回显。
- 审批被任一端处理后发 `permission_resolved {requestKey, optionId|null, by}`；提问被回答发 `elicitation_resolved {requestKey, by}`
  （现有 `elicitation_cancelled` 保留）。另一端据此收卡，不靠本地状态。

### 3.3 REST（camelCase）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/acp/engines` | `[{id,label,available,requirement}]` |
| GET | `/api/acp/chats` | `[{chatId,engineId,cwd,title?,acpSessionId?,status,lastSeq,origin,pendingPermissions,botId?,updatedAt}]`；`status` = snapshot phase（starting/ready/generating/exited/failed）；`origin` ∈ desktop/mobile/bot |
| GET | `/api/acp/history` | 同 `list_acp_chat_history` |
| POST | `/api/acp/chats` | `{engineId,cwd,resumeAcpSessionId?,autoApproveKinds?}` → `{snapshot,lastSeq}`；chatId = `mobile-<uuid>`；cwd 必须是已存在目录 |
| GET | `/api/acp/chats/{id}` | `{snapshot,lastSeq}`（**嵌套形状**） |
| POST | `/api/acp/chats/{id}/prompt` | `{blocks, promptId?}`（无 promptId 时服务端生成并回包 `{promptId}`） |
| POST | `/api/acp/chats/{id}/cancel` | |
| POST | `/api/acp/chats/{id}/mode` \| `/model` \| `/config` | `{modeId}` \| `{modelId}` \| `{configId,value}` |
| POST | `/api/acp/chats/{id}/permission` | `{requestKey, optionId: string\|null}`（null = 取消） |
| POST | `/api/acp/chats/{id}/elicitation` | `{requestKey, response:{action:"accept"\|"decline"\|"cancel", content?}}` |
| DELETE | `/api/acp/chats/{id}` | stop |

错误体统一 `{code,message}`；写操作受只读策略（403 `READ_ONLY`）。

### 3.4 WS：`/ws/acp/{chatId}?afterSeq=N`

```jsonc
{"type":"event","seq":42,"kind":"update","payload":{...}}
{"type":"reset","snapshot":{...},"floorSeq":100}   // 客户端清空 transcript，套 snapshot 后接收从 floorSeq 起的重放
{"type":"synchronized","lastSeq":57}
```

服务端顺序：先订阅实时 → 读环 → `afterSeq < floorSeq-1` 时发 `reset` → 补发 `seq > max(afterSeq, floorSeq-1)` → `synchronized` → 实时（过滤已发）。
**snapshot 与随后重放的 `state` 事件：后到者为准**（state 是增量真相）。握手阶段的 401/403/404/503 以 HTTP 状态码返回（升级前），不进 WS。

### 3.5 实现备注（P2 后端落地时补充，均为向后兼容的增量）

- `afterSeq > lastSeq`（app 重启后 seq 重新计数）同样发 `reset`；空环时 `floorSeq = lastSeq + 1`。
- `POST /prompt`：客户端给的 `promptId` 原样写进 `user_prompt`；同一 chat 已接纳过该 promptId 时不再发第二轮，直接回 `{promptId, duplicate:true}`（手机网络重试幂等）。
- `*_resolved.by` 与 `user_prompt.origin` 同一词表；取消回合等宿主侧收卡记为 `desktop`。`permission_resolved` 另带 `optionId`（取消为 null），ACP 会话还保留原有 `result`；`elicitation_resolved` 带 `action`。
- web → orchestrator 用 `x-ccpanes-origin`（URL 编码）转告来源：设备令牌 = `device:<设备名>`，Cookie 会话 = `mobile`；orchestrator 只接受这两种形态，不能冒充 `desktop`。
- 错误状态码：`ACP_SESSION_NOT_FOUND` 404；`ACP_CWD_INVALID` / `ACP_ENGINE_UNKNOWN` / `ACP_PROMPT_REQUIRED` 等 400；`ACP_TURN_IN_PROGRESS` / `ACP_SESSION_NOT_READY` / `ACP_ENGINE_UNAVAILABLE` / `ACP_PERMISSION_NOT_PENDING` 409；上游超时 504 `ACP_HOST_TIMEOUT`；manifest 令牌被拒视同 app 不在（503）。
- 配对（docs/111）：`/api/device/info` 与 `POST /api/device/pair` 成功体带可选 `instanceId`（`<data>/instance-id`，首次生成后稳定）；配对失败体为 `{code,message}`：`DEVICES_NOT_ALLOWED` / `PEER_NOT_ALLOWED`（403）、`PAIR_CODE_INVALID` / `PAIR_CODE_EXPIRED` / `PAIR_TOO_MANY_ATTEMPTS`（401）。

## 4. P3：配对与电脑地址簿（手机侧）

- 复用 docs/111：电脑「设置 → Web 访问 → 其他设备 → 允许其他设备连接」生成 6 位配对码；手机 `POST /api/device/pair {code,name}` 换 `ccp_dev_…`，存 Keychain（kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly）。
- 之后 REST 带 `Authorization: Bearer`，WS 用 `?token=`。设备令牌视同本机主人（不受远程只读限制，见 111）。
- 地址簿：多台电脑（名称、地址列表、令牌引用、最近在线）；`/api/health` + `/api/device/info` 探活；同一台电脑可存多条地址（局域网 IP、Tailscale 100.x），按「局域网优先、Tailscale 兜底」并发探测择优（t3code 做法）。
- 桌面端补一个「显示配对二维码」（内容 `ccpanes://pair?host=…&code=…`，码只在 URL fragment 外不落日志）。

## 5. P4：Bot 组网

> 状态：后端 + 桌面 UI 已落地（`src-tauri/src/services/bot_mesh/`、`cc-panes-web/src/routes/mesh.rs`、`web/components/bots/`）。
> 本节即契约；与早期设计稿不同之处见 §5.8。

### 5.1 发现与连通

- **身份**：`<data>/instance-id`（`/api/device/info` 的 `instanceId`）+ 设备名（主机名）。
- **信任靠配对**：发现只是「看见」，互联必须走一次 docs/111 配对（6 位码 → `ccp_dev_` 令牌），双向各存一份（A 连 B 用 B 发的令牌）。对端本体就是「设备」视图里的直连 / SSH 设备（`devices.json` + keyring），组网附加信息存 SQLite `mesh_peers`（v47：地址候选 `lan`/`tailscale`/`manual`、实例 id、主机名、上次成功地址、最近在线）。
- **局域网 mDNS**：服务类型 `_ccpanes._tcp.local.`，TXT `instanceId` / `name` / `version` / `port`。**只在「Web 访问开启 + 允许其他设备连接」时广播**（默认不广播；启动时与改 Web 访问时对齐）。浏览按需进行（打开「其他电脑」/ 点重新扫描，约 2 秒窗口），不常驻。
- **Tailscale**：只读 `tailscale status --json`；对在线节点的 100.x 地址按「本机 Web 端口 / 18080」探 `/api/health`。CLI 不在 / 未连接时在发现结果里如实报 `tailscale: notInstalled | stopped | error`（界面可见，不报错）。
- **择优**：上次成功地址先试；不通再并发试其余候选，按来源优先级 `lan > tailscale > manual` 取胜者，写回 `preferredUrl` / `lastSeenAt`。发现到的地址按实例 id / 主机名归并到已配对对端。只在被调用时探测（列联系人 / 发消息），**不给任何对端起常驻轮询**；联系人汇总缓存 8 s。

### 5.2 Peer API（cc-panes-web → 桌面 orchestrator `/mesh/*`）

鉴权与 `/api/acp/*` 相同（Cookie 或设备令牌，过只读守卫；**任何设备令牌都可用**，含手机的主人令牌）。web 只做鉴权 + 透传：app 不在 → 503 `ACP_HOST_UNAVAILABLE`。来源经 `x-ccpanes-origin` 告知：设备令牌 = `device:<设备名>`，Cookie = `mobile`。错误体统一 `{code,message}`。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/bots` | 本机**共享的** Bot，**裸数组** `SharedBot[]`（见下） |
| PATCH | `/api/bots/{id}` | `{remotePolicy?, remoteAllowKinds?, remoteShared?, confirmFull?}` → `SharedBot`；改成 `full` 必须 `confirmFull:true`，否则 400 `BOT_FULL_CONFIRM_REQUIRED` |
| POST | `/api/bots/{id}/messages` | `{text, promptId?, traceId?, hops?, from?:{device?,instanceId?,bot?,botName?,user?}}` → `DeliverAck`。**立即回执**，回合在后台跑 |
| GET | `/api/bots/{id}/messages/{promptId}` | 轮询回复：`MeshMessage`（见下） |
| — | 回复（流式） | 也可订阅 `/ws/acp/bot-{id}?afterSeq=`（P2 原样）；`user_prompt.promptId` = 上面的 promptId，按它截取本轮 |

```jsonc
// SharedBot
{"id":"…","name":"…","avatar":"🤖","color":"#6366f1","engineId":"claude",
 "personaSummary":"人设首行（≤80 字）","status":"idle","remotePolicy":"ask_origin",
 "remoteAllowKinds":[],"remoteShared":true,"chatId":"bot-…"}
// status：idle（未启动）| starting | ready | generating | exited | failed
//   展示建议：ready=在线，generating/starting=工作中，其余=未启动

// DeliverAck
{"chatId":"bot-…","promptId":"…","traceId":"tr-…","hops":0,"policy":"ask_origin","duplicate":true?}

// MeshMessage
{"promptId":"…","traceId":"…","hops":0,"botId":"…","chatId":"bot-…",
 "status":"queued|running|waiting_permission|done|failed",
 "policy":"ask_origin",            // 生效档（Cookie 来源的 full 已降级）；本机 Bot→Bot 无
 "origin":"device:Wu's iPhone",    // 权威来源（令牌决定，不看 body.from）
 "from":{…}, "reply":"…"?, "error":{"code","message"}?,
 "pendingPermissions":[{"requestKey":"…","params":{toolCall,options}}],
 "createdAt":ms, "finishedAt":ms?}
```

- 缺 `hops` = 0（人发起），缺 `traceId` = 服务端生成；`promptId` 原样进 `submit_external` / `user_prompt`（手机据此抵消本地回显），同一 promptId 重发回原回执 `duplicate:true`。
- 错误：Bot 不存在 404 `BOT_NOT_FOUND`；未共享 403 `BOT_REMOTE_DENIED`；`hops>3` 400 `MESH_HOPS_EXCEEDED`；traceId 回到已经过的 Bot 409 `MESH_LOOP_DETECTED`；在途过多 429 `MESH_BUSY`；空正文 400 `ACP_PROMPT_REQUIRED`。
- 审批：`pendingPermissions` 里的卡，发起方用已有 `POST /api/acp/chats/bot-{id}/permission {requestKey, optionId|null}` 处理（本机桌面同时也能代批）。

### 5.3 远程权限策略（按 Bot）

Bot 新字段（`bot.json`，缺省兼容旧文件）：`remoteShared`（默认 **true**）、`remotePolicy`（默认 `ask_origin`）、`remoteAllowKinds`。

| 级别 | 远程回合期间的行为 |
|------|------|
| `deny` | 可以聊天；任何工具审批自动拒绝（选 `reject_once`，没有就取消），提问自动 decline |
| `ask_origin` | 自动放行集合清空，所有审批留给发起方（经 `pendingPermissions` / WS）与本机主人 |
| `allowlist` | 自动放行 = `remoteAllowKinds`（不接受 `*`），其余同 ask_origin |
| `full` | **最高权限**：自动放行 `["*"]`（与 Automations headless 同一通道），漏网的卡也兜底放行。**只对设备令牌来源生效**，Cookie 网页会话降级为 ask_origin；桌面 UI 红色警示 + 系统确认，列表常驻「全权」徽标 |

- 实现：远程回合占到会话后把会话的自动放行集合**临时替换**为上表，回合结束（含失败 / 超时 / 没占到）立刻恢复 Bot 自己的设置；另有一个只看本轮（从本条 `external_prompt` 到 `turn_ended`）的事件订阅兜底执行 deny/full 并登记待审批。审批被策略处理时 `permission_resolved.by = "policy:<级别>"`。
- 只作用于「由远程消息开启的回合」；本机桌面 / IM 的回合不受影响。`remoteShared=false` 时远程消息直接 403。
- 不共享的 Bot 不出现在 `/api/bots`；本机桌面「联系人」照常显示。

### 5.4 Bot → Bot（MCP）与防环

- orchestrator MCP（core 面）新增 `list_contacts {refresh?}` 与 `message_contact {device?, bot, text, waitReply?=true, timeoutSecs?=300}`：`device` = deviceId 或电脑名（省略 / `local` = 本机），`bot` = id 或名字。返回 `{timedOut, entry: OutboxEntry}`（`waitReply:false` 直接返回 `OutboxEntry`）。本机 Bot 走本地投递，远程 Bot 走 §5.2。
- **调用方识别**：Bot 会话的 ccpanes MCP 地址带 `acpChatId=bot-<id>`；该 Bot 正在服务某条远程消息时，traceId 接力、`hops+1`；否则开新 trace，agent 发起至少算 1 跳。
- **防环**：`hops ≤ 3`；每个节点记 (traceId, botId)（有界 4096 条 / 1 h），发起方也记自己——同一 traceId 回到已经过的 Bot 即 409 `MESH_LOOP_DETECTED`。

### 5.5 通讯录聚合

- 手机：对每台已保存的电脑各自 `GET /api/bots`（用该电脑的令牌），直接对该电脑开 `/ws/acp/bot-{id}`（§5.2）。
- 桌面 / 也可给手机用的聚合：`GET /api/contacts?refresh=1` → `{instanceId, deviceName, groups:[ContactGroup]}`，`ContactGroup = {deviceId("local"=本机), name, local, status(online|offline|unauthorized|unsupported|error), online, error?, address?, instanceId?, lastSeenAt?, bots: SharedBot[]}`。经设备令牌调用时本机组只含共享的 Bot。
- 经本机**转发**给其他电脑上的 Bot（手机只与一台电脑配对时可用）：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/contacts/{deviceId}/{botId}/messages` | `{text, promptId?}` → `OutboxEntry`（对端看到的来源是本机设备名，即按本机与对端的配对关系授权） |
| GET | `/api/contacts/{deviceId}/{botId}/messages/{promptId}` | `OutboxEntry`（后端每条在途发件一个跟踪任务，1.2 s 一次，终态即停） |
| POST | `/api/contacts/{deviceId}/{botId}/permission` | `{requestKey, optionId\|null}` → 转给对端 `/api/acp/chats/bot-{id}/permission` |

`OutboxEntry = {id(=promptId), deviceId, deviceName, botId, botName, text, traceId, hops, sender, status, reply?, error?, pendingPermissions, createdAt, updatedAt}`；桌面经 Tauri 事件 `bot-mesh-outbox-changed` 推送。

### 5.6 桌面 UI

「联系人」：本机 Bot / 其他电脑两组（在线点、离线灰显、状态说明）；本机 Bot 菜单「远程权限…」（共享开关 + 四档，allowlist 勾选类型，full 红色警示 + 二次确认）；标题栏「其他电脑」对话框：已配对电脑（地址候选、最近在线、移除）、局域网 / Tailscale 发现（点选自动填地址）、配对码互联；点其他电脑的 Bot 打开发消息对话框（回复、待审批按钮）；有待审批时列表顶部出现提示条。

### 5.7 本机 Tauri 命令

`mesh_contacts / mesh_peers / mesh_discover / mesh_pair_peer / mesh_remove_peer / mesh_send / mesh_outbox / mesh_clear_outbox / mesh_respond_permission / mesh_set_bot_remote`（`web/services/botMeshService.ts`）。

### 5.8 与早期设计稿的差异

1. `deny` 不再是「拒收消息」，而是「可聊天、工具一律自动拒绝」；拒收改由 `remoteShared=false` 表达（仍是 403 `BOT_REMOTE_DENIED`）。
2. `POST /messages` 请求体扩展 `promptId? / traceId? / hops?`（均可缺省），回执扩展 `traceId / hops / policy / duplicate?`。
3. 新增轮询 `GET /api/bots/{id}/messages/{promptId}`（WS 仍可用）、`PATCH /api/bots/{id}`、`GET /api/contacts` 与 `/api/contacts/{deviceId}/{botId}/*` 转发三件套。
4. `/api/bots` 条目在 §5.2 原字段外增加 `color / remoteAllowKinds / remoteShared / chatId`；`status` 取值见上。
5. `message_contact` 参数名为 `device / bot / text / waitReply / timeoutSecs`（device 可省略）。
6. 桌面打开远程 Bot 用「发消息对话框 + 发件跟踪」，未做「只读 + 可发送的远程 Agent Chat 标签」。

## 6. P6：手机本地会话与密钥导入

> 状态：已落地。iOS `cc-panes-ios/CCPanes/Local/`；后端 `cc-panes-core/src/services/provider_export_service.rs`、
> `src-tauri/src/services/provider_export_routes.rs`、`src-tauri/src/commands/provider_export_commands.rs`、
> `cc-panes-web/src/routes/provider_export.rs`；桌面 UI `web/components/providers/ProviderExportDialog.tsx`。

### 6.1 手机本地会话

- **在手机上跑、不需要电脑**：手机直连供应商 API 流式对话。两种协议按供应商的 `kind` 选：
  - `anthropic`：`POST {base}/v1/messages`（`base` 为根地址；以 `/v1` 结尾则拼 `/messages`），头 `x-api-key` + `anthropic-version: 2023-06-01`；
    非 `api.anthropic.com` 的中转同时带 `Authorization: Bearer`（对齐 Claude Code `ANTHROPIC_AUTH_TOKEN` 生态）。
    解析 `message_start`（模型、输入 token，含 cache 读写）/ `content_block_delta`（`text_delta`、`thinking_delta`）/
    `message_delta`（`stop_reason`、输出 token）/ `message_stop` / `error`。
  - `openai_chat`：`POST {base}/chat/completions`（`base` 到 `/v1` 级），`Authorization: Bearer`，带
    `stream_options.include_usage`（中转回 400 且报错里提到 `stream_options` 时自动去掉重试一次）。
    解析 `choices[0].delta.content` / `reasoning_content|reasoning` / `finish_reason` / `usage` / `[DONE]` / `{"error":…}`。
- **SSE 解析按字节切行**（`\r\n` 在 Swift 里是一个 Character；多字节 UTF-8 可能被网络分片切开，只在行尾解码）。
- 停止 = 取消消费任务（`AsyncThrowingStream.onTermination` 取消底层 `URLSession.bytes`）；错误一律映射成中文（401/403/404/429/5xx/529、
  流内 `overloaded_error` 等、超时 / 断网 / TLS / DNS）。v1 **不带工具 / shell**（只有文本 + Markdown + 思考折叠）。
- **持久化**：`Application Support/CCPanesLocal/`——`providers.json`（元数据）、`chats/<id>.json`（每条对话一个文件，原子写、
  `completeUntilFirstUserAuthentication`），不用 UserDefaults。标题取首条消息首行（≤24 字），可改名 / 删除 / 继续对话；
  每条回复记录模型与 token 用量（服务端回报时）。生成中每 1.5 s 节流落盘。
- **集成**：本机对话是伪电脑「本机 iPhone」（`LocalChatListItem.computerId = "local-iphone"`）：
  合并「对话」列表与远程对话按时间混排、带「本机」芯片；「新建对话」的电脑选择器多一项「本机 iPhone」（选供应商 + 模型）；
  统一搜索收录本机对话；电脑面板 / 设置有「本机模型」入口（导入 + 手动添加）。底部状态条的在线台数只算真实电脑。
  地址簿为空时连接页可选「先在本机使用」（`ccpanes.localOnly`）直接进首页。
- 后续（未做）：把用户的 Bot（通讯录）作为本地会话的工具；图片输入。

### 6.2 密钥存储

- API Key **只在 Keychain**：service `com.ccpanes.ios.llm-key`，account = 本机供应商 id，`AfterFirstUnlockThisDeviceOnly`（不随备份迁移）。
  `providers.json` 里只有名称 / 协议 / 地址 / 模型 / 默认模型 / 来源电脑；日志与 `description` 不含密钥。

### 6.3 从桌面导入（导出码）

与配对同构的一次性流程：

1. 桌面「设置 → 供应商（凭证页）→ 导出到手机」：勾选供应商（不支持的类型、没密钥的置灰并注明原因）→ 生成 **6 位导出码**
   （5 分钟有效、单次使用、生成新码即作废旧码）。码只存 SHA-256、只活在**桌面进程内存**。
2. 手机「本机模型 → 从电脑导入」：选一台**已配对**（有设备令牌）的在线电脑、输码 →
   `POST /api/providers/export {code}`（`Authorization: Bearer ccp_dev_…`）。
3. cc-panes-web 只做鉴权 + 透传到桌面 orchestrator `POST /provider-export/redeem`（`x-ccpanes-origin: device:<设备名>`）；
   桌面进程校验码、读钥匙串（不让 web 这个别的可执行文件去读，避免 macOS 授权框）、返回 payload；手机写 Keychain + 元数据。

```jsonc
// 200（Cache-Control: no-store）
{"version":1,"exportedAt":"…",
 "providers":[{"id":"桌面 id","name":"…","providerType":"proxy","protocol":"anthropic|openai_chat",
               "baseUrl":"…","models":[{"id":"…","label":"…"}],"defaultModelId":"…","apiKey":"sk-…"}],
 "skipped":[{"id":"…","name":"…","reason":"NO_API_KEY|UNSUPPORTED_TYPE|SECRET_UNAVAILABLE|NOT_FOUND"}]}
```

| 状态 | code | 含义 |
|------|------|------|
| 400 | `EXPORT_CODE_INVALID` | 码错（带 `attemptsLeft`）/ 没有进行中的导出（不区分，避免成为探测信号）/ 非 6 位数字 |
| 401 | `INVALID_DEVICE_TOKEN` | 令牌无效 / 已吊销 |
| 403 | `DEVICE_TOKEN_REQUIRED` | 没带设备令牌（Cookie 网页会话、回环免登录一律拒绝——即使回环其余接口免鉴权） |
| 403 | `READ_ONLY` | 远程只读（`read_only_guard`，设备令牌本身不受只读限制） |
| 410 | `EXPORT_CODE_EXPIRED` | 过期（导出随之作废） |
| 429 | `EXPORT_CODE_LOCKED` | 本次导出错 5 次，已作废 |
| 429 | `EXPORT_RATE_LIMITED` | 全局失败窗口：10 分钟内 10 次失败后一律拒绝（不比对码、不消耗次数） |
| 503 | `ACP_HOST_UNAVAILABLE` | 桌面 app 不在（headless web 没有导出能力） |

- **协议映射**（桌面 → 手机）：Anthropic / Proxy / LocalGateway → `anthropic`（缺地址用官方）；OpenAI → `openai_chat`
  （Chat 地址优先、Responses 地址回退、缺省官方 `/v1`）；Gemini → `openai_chat`（官方 OpenAI 兼容端点）；Kimi / OpenCode / Grok →
  Chat 地址，没有则用其 Anthropic 地址；Bedrock / Vertex / ConfigProfile（登录态）/ Cursor 不可导出。模型取未隐藏的条目。
- **安全性质**：设备令牌（主人）+ 有效码缺一不可；码错消耗次数 + 全局限流；成功即作废；审计日志
  （`target: cc_panes::audit`）只记来源设备名、导出 / 跳过数量与供应商名称，**不记码与密钥**；不存在任何返回密钥的 GET / 列表接口
  （候选列表 `provider_export_candidates` 只有「有无密钥」）；响应 `no-store`。桌面经 Tauri 事件 `provider-export-changed`
  （`redeemed` / `cancelled`）关闭对话框并提示。
- 重复导入：同一台电脑的同一条（`originId` + 电脑名）覆盖更新，不新增。
- **debug 构建专用夹具**（release 无此路由）：orchestrator `POST /provider-export/debug/fixture {action:create|delete,id,key?}`
  与 `POST /provider-export/debug/start {providerIds}`，在桌面进程内建删假供应商 / 跳过 UI 生成导出码，供 E2E 使用。

### 6.4 Tauri 命令

`provider_export_candidates / provider_export_start {providerIds} / provider_export_cancel / provider_export_status`
（`web/services/providerExportService.ts`）。

## 7. 风险与约束

- 改 `src-tauri/` 会让正在跑的 `tauri dev` 重建（CLAUDE.md gotcha）——开工前确认没人在测 dev。
- web 透传层对未知 kind 不得丢弃（docs/94 漂移探针）。新增跨进程事件链路先问「daemon 模式下这份数据在谁的地址空间里」——ACP 不进 daemon，在 app 进程。
- `full` 策略等于把本机执行权交给已配对设备：配对令牌吊销必须即时生效（111 已按 mtime 热加载）。

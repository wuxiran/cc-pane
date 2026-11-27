# 112 · iOS 原生客户端 + Bot 组网

> 状态：P1（终端镜像）、P2 iOS 侧（对话 UI，mock 验证）已完成；P2 后端桥、P3 配对/地址簿、P4 Bot 组网进行中。
> 前置阅读：docs/94（ACP Agent Chat）、docs/111（多设备：设备令牌与配对码）、`src-tauri/src/services/bot_service.rs`（Bot 联系人）。
> 代码与构建：`cc-panes-ios/README.md`。参考：t3code 移动端（序号续传、审批卡停靠、后台策略）。

## 1. 定位

- **手机 = 只看不跑的节点**：CLI / ACP agent / Bot 都跑在电脑上（要读写仓库，iOS 跑不了 npx/claude），手机经电脑端 API 看、说、批。
- **每台电脑 = 一个 CC-Panes 节点**，各自养 Bot；节点之间经 docs/111 的设备令牌互联，组成 **Bot 网络**。
- **通讯录 = 全网 Bot 的并集**：手机和任一台电脑都能看到、对话所有已配对设备上的 Bot。
- 唯一不经电脑的例外：手机「直连大模型」（P6），纯对话、不碰代码。

## 2. 分期

| 期 | 内容 | 状态 |
|----|------|------|
| P1 | 终端镜像：布局镜像首页、工作区启动、终端（`endSeq` 续传、desync 原地重同步、适配尺寸、屏蔽查询自动应答） | ✅ |
| P2 | **ACP 移动桥**：`/api/acp/*` + `/ws/acp/{chatId}`，手机与桌面 Agent Chat 双向同一份 | iOS ✅（mock）/ 后端进行中 |
| P3 | **配对 + 电脑地址簿**：手机复用 docs/111 配对码换 `ccp_dev_` 令牌（Keychain），多台电脑保存/切换/在线状态；Tailscale / 局域网地址 | 进行中 |
| P4 | **Bot 组网**：跨设备 Bot 目录、人→远程 Bot、Bot→Bot（MCP 工具）、按 Bot 的远程权限策略 | 设计定稿 |
| P5 | 推送 / 灵动岛（审批、完成）、在线状态续租 | 待做 |
| P6 | 手机直连大模型 API（Keychain 存 key，与 ACP 共用对话 UI） | 待做 |

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

### 5.1 发现与连通

- **Tailscale 优先 + 局域网 mDNS**：节点在局域网广播 `_ccpanes._tcp`（TXT：instanceId、名称、版本、端口）；跨网靠 Tailscale tailnet IP（docs/111 已限定 http + 100.x）。不自建中转。
- **信任靠配对**：发现只是「看见」，互联必须走一次配对（docs/111 设备令牌），双向各存一份令牌（A 连 B 用 B 发的令牌）。

### 5.2 Peer API（cc-panes-web，设备令牌鉴权）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/bots` | 本机 Bot 目录：`[{id,name,avatar,engineId,personaSummary,status,remotePolicy}]`（不含完整人设） |
| POST | `/api/bots/{id}/messages` | `{text, from:{device,bot?,user?}}` → `{chatId:"bot-{id}", promptId}`；走 `BotService::submit_external`，来源记 `device:<name>` |
| — | 回复 | 订阅 `/ws/acp/bot-{id}?afterSeq=` 按 promptId 截取（复用 P2，不另开协议） |

app 未运行 → 503；Bot 不存在 → 404；策略拒绝 → 403 `BOT_REMOTE_DENIED`。

### 5.3 远程权限策略（按 Bot）

`Bot.remotePolicy`（默认 `ask_origin`）：

| 级别 | 行为 |
|------|------|
| `deny` | 拒收远程消息 |
| `ask_origin` | 审批回传发起方（手机/发起设备上弹卡），本机桌面也可代批 |
| `allowlist` | 命中 `autoApproveKinds`（read/search/fetch/edit/execute…）自动放行，其余回传发起方 |
| `full` | **最高权限**：远程触发的回合全部自动放行（`autoApproveKinds = ["*"]`，与 Automations headless 同一通道） |

- `full` 只对「已配对设备」生效，开启时 UI 二次确认并常驻警示徽标；每条远程触发的工具调用照常进 journal，可审计。
- 策略作用于「由远程消息开启的回合」，不影响本机桌面上手动发起的回合。

### 5.4 Bot → Bot

- orchestrator MCP 新增 `list_contacts`（全网 Bot 目录，含设备）与 `message_contact(device, bot, text, waitReply?)`；本机 Bot 走本地 `submit_external`，远程 Bot 走 5.2。
- 防环：消息携带 `hops`（≤3）与 `traceId`；同一 traceId 回到已经过的 Bot 即拒绝。

### 5.5 通讯录聚合

- 桌面「联系人」与手机「通讯录」都显示 **本机 Bot + 各已配对设备的 `/api/bots`**（按设备分组，离线设备灰显）。
- 点开远程 Bot：手机直接对该设备开 `/ws/acp/bot-{id}`；桌面在本机开一个只读+可发送的远程 Agent Chat 标签（复用 111 的远程会话路由思路）。

## 6. 风险与约束

- 改 `src-tauri/` 会让正在跑的 `tauri dev` 重建（CLAUDE.md gotcha）——开工前确认没人在测 dev。
- web 透传层对未知 kind 不得丢弃（docs/94 漂移探针）。新增跨进程事件链路先问「daemon 模式下这份数据在谁的地址空间里」——ACP 不进 daemon，在 app 进程。
- `full` 策略等于把本机执行权交给已配对设备：配对令牌吊销必须即时生效（111 已按 mtime 热加载）。

# 88 · IM 外推桥：钉钉 / 企业微信 / 飞书 通知集成（含双向 roadmap）

> 状态：批次 1（出站单向推送）已落地；批次 2-4（双向）未实施。
> 审批快照见 plan 文件，正式规格以本文为准。

## 背景与可行性结论

需求：会话事件（任务完成 / 出错 / 等待输入 / 退出）推送到钉钉、企业微信、飞书，
并支持双向交互（IM 里回复注入会话、卡片按钮执行"继续/批准"）。不做 RAG。

三个关键调查结论：

1. **`cc-notify` 曾是零调用方的孤儿 crate**：钉钉/飞书渠道实现现成，只缺企微。
   批次 1 已将其重构为**纯协议 crate**（`build_request(cfg, payload, now_ms) -> BuiltRequest`
   纯函数，无传输层），签名向量与 Python 参考实现核对。
2. **双向免公网可行**（桌面应用无公网 IP）：
   - 钉钉 Stream 模式：WebSocket，协议完全公开（JSON 帧），Rust 可自实现；
     凭证 = 企业内部应用 clientId/clientSecret；配额标准版 5000 次/月；仅组织内部群。
   - 企业微信「智能机器人」长连接：`wss://openws.work.weixin.qq.com`，协议全公开
     （`aibot_subscribe` 鉴权 / `template_card_event` 按钮回调 / 30s ping）；
     **每机器人同时仅 1 条连接（新踢旧）**；主动推有「用户先给机器人发过消息」前置；
     30 条/分/会话。传统自建应用必须公网回调，不可用。
   - 飞书长连接：免公网但**帧协议官方不公开**、无 Rust SDK——默认不做真双向（批次 4）。
   - 三家群 webhook（单向）都不支持按钮回调，按钮只能跳 URL。
3. 事件源：`session_state_machine.rs::subscribe_transitions()`（broadcast）覆盖全部事件；
   会话操作复用 orchestrator 既有 submit/write/read/kill 原语。

## 架构决策

- **D1** cc-notify = 纯协议/格式化 crate；出站统一 src-tauri 的 reqwest
  （rustls + socks feature；按 `ProxySettings` 构造代理——应用自身 HTTP 接用户代理的第一个消费者）。
- **D2** 连接管理挂 **app 进程**（`src-tauri/src/services/im_bridge/`），不进 daemon
  → 不碰 `boundary_events.rs` 契约表；代价「app 关了 IM 桥断」，v1 接受。
- **D3** 事件接入用 `subscribe_transitions()` broadcast + tokio task，
  **不用** sync `subscribe` 回调（hook/PTY 线程执行，禁网络 IO）。
- **D4** IM 闸门独立于桌面通知：`only_when_unfocused` 对 IM 语义相反
  （用户不在电脑前才最需要），默认聚焦时也推（`ImSettings.push_when_focused = true`）。
  复用 dedupe(10s, `im:` 前缀) + TaskBinding `metadata.ui.muted`。
- **D5**（批次 2+）入站会话操作经窄 trait `SessionOps` 适配 orchestrator 既有服务层。

## 批次 1 落点（已实施）

| 层 | 文件 |
|---|---|
| 协议 crate | `cc-notify/src/models.rs`（+Wecom/secret/events/kind；`subscribes()` 空=全订阅）、`channels/*.rs` 纯函数化（钉钉 HMAC 加签 / 飞书 body 签名，向量单测） |
| 服务 | `src-tauri/src/services/im_bridge/mod.rs`（闸门 + reqwest 传输 + 每渠道结果落账 + `im-channel-result` 事件）、`outbound.rs`（transition → kind 映射消费者） |
| 装配 | `src-tauri/src/lib.rs` orchestrator 启动块尾部：construct + manage + spawn consumer |
| 设置 | `cc-panes-core/src/models/settings.rs::ImSettings`（`#[serde(default)]`）；TS 镜像 `web/types/settings.ts` |
| 命令 | `src-tauri/src/commands/im_commands.rs`：`test_im_channel` / `get_im_bridge_status` |
| 前端 | `web/components/settings/ImSection.tsx`（渠道 CRUD/事件勾选/发送测试）、registry pane `im-bridge`（system 页，仅 tauri）、i18n en+zh |

事件 kind 与 dedupe（与 NotificationService 同口径，前缀 `im:`）：
`turn_end`（`im:turn_end:{sid}:{turn_seq}`）/ `waiting_input` / `error`（含 error_type）/
`session_exited`（hook SessionEnd 与 pty-exit 双路径 dedupe 收敛）。`slow_tool` 批次 4 补。

已知取舍：
- 凭证明文存 config.toml（与 Provider API key 同级），UI 打码 + 提示文案。
- `send_built` 解析 body 的 `errcode`/`code`（HTTP 200 但业务失败时错误在 body 里），
  测试按钮能给出「sign not match」级别的真实反馈。
- 测试注意：宿主机设有 HTTP_PROXY 时 reqwest 默认读 env，把 127.0.0.1 mock 请求
  路由进真实代理（实测 502）——测试内 client 必须 `.no_proxy()`。

## 批次 2-4 roadmap（未实施）

- **批次 2 钉钉 Stream 双向**：`stream/dingtalk.rs`（tokio-tungstenite 自实现，
  ticket 90s 每次重连重取）+ `backoff.rs`（1s→60s 指数退避）+ `guard.rs`（单实例锁
  `runtime/im-bridge.lock`，防同 flavor 双开）+ `router.rs` 安全模型：
  allowlist **fail-closed**（空=拒绝所有入站）、`/bind <6位配对码>`（60s）、
  会话短别名 `#3`、注入类命令必须显式带别名、卡片按钮 nonce+exp+本地 HMAC 防重放、
  `/kill` 二次确认、自由文本直通默认关、入站审计。
- **批次 3 企微智能机器人双向**：复用批次 2 基础设施；被踢（新踢旧）不无限抢连——
  退避到顶置 `TakenOver` 显式态需手动重连（dev/release 双开会互踢死循环）；
  每 conversation 令牌桶（30 条/分）超限合并摘要。
- **批次 4 飞书 + 收尾**：默认「伪双向」（按钮跳 URL 深链 cc-panes-web 会话页）；
  真双向走 Go SDK 边车（external binary pattern，继承 binaries 陈旧 + stdin 两条 gotcha），
  先实测 `card.action.trigger` 是否真走长连接再排期。收尾：slow_tool、渠道连败亮红。

## 风险与不做的事

- 不做：飞书私有协议逆向、RAG、连接管理进 daemon、OS keyring、终端原始输出持续转发
  （配额必爆——只推事件摘要，`/tail` 按需拉取）。
- 最大运维风险 = 多实例抢连接（平台侧单连接语义，与 dev/release 串台 gotcha 同型）：
  靠连接状态区 + `TakenOver` 显式态兜底，绝不静默重连死循环。
- 入站注入 = 替用户打字：allowlist fail-closed / 显式别名 / kill 二次确认三道闸不可省。

## 验收清单（真机）

批次 1：三平台各建群机器人 → 「发送测试」按钮成功；触发 4 类事件各收到一条；
错误配置（钉钉加签错 secret）时测试按钮报 `sign not match`；关主开关后不再外推。
批次 2+ 的验收见 roadmap 各条。

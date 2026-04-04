# Claude Code Bridge 远程控制架构分析

> 基于 Claude Code 2.1.88 源码分析，提供实现云端远控的参考。

## 一、架构概览

Claude Code 的远程控制通过 **Bridge 模式** 实现，核心是云端中转：

```
外部程序（Web/App）
    ↕ OAuth + REST API
claude.ai CCR 云端 API（中转服务器）
    ↕ SSE/WebSocket + Worker JWT
Claude Code CLI（本地执行代码操作）
```

**关键点：所有通信经过 Anthropic 云端服务器，本地 CLI 不开放任何端口。**

---

## 二、核心源码文件清单

| 文件路径 | 作用 |
|---------|------|
| `src/bridge/remoteBridgeCore.ts` | Bridge v2 (Env-less) 核心实现 |
| `src/bridge/bridgeMain.ts` | Bridge 主循环 / Headless daemon |
| `src/bridge/codeSessionApi.ts` | 会话 API 封装（创建会话、获取凭证） |
| `src/bridge/bridgeEnabled.ts` | Bridge 启用检查（订阅+门控） |
| `src/bridge/bridgeMessaging.ts` | NDJSON 消息处理 |
| `src/bridge/bridgeApi.ts` | Bridge API 客户端 |
| `src/bridge/trustedDevice.ts` | 信任设备令牌 |
| `src/cli/remoteIO.ts` | 双向流传输（SDK 模式） |
| `src/cli/structuredIO.ts` | 结构化 I/O（NDJSON 格式） |
| `src/cli/transports/SSETransport.ts` | SSE 传输实现 |
| `src/entrypoints/cli.tsx` | CLI 入口（remote-control 命令） |
| `src/entrypoints/sdk/controlTypes.ts` | 控制协议类型定义 |
| `src/services/policyLimits/index.ts` | Policy 限制检查 |
| `src/utils/auth.ts` | OAuth 认证工具 |
| `src/tools/RemoteTriggerTool/` | 定时远程任务工具 |

---

## 三、API 调用流程

### 3.1 创建会话

```http
POST /v1/code/sessions
Authorization: Bearer {oauth_access_token}
Content-Type: application/json
anthropic-version: 2023-06-01

{
  "title": "My Remote Session",
  "bridge": {},
  "tags": ["remote"]
}
```

**响应：**
```json
{
  "session": {
    "id": "cse_xxxxxxxxxx"
  }
}
```

### 3.2 获取 Bridge 凭证

```http
POST /v1/code/sessions/{session_id}/bridge
Authorization: Bearer {oauth_access_token}
X-Trusted-Device-Token: {optional_device_token}
```

**响应：**
```json
{
  "worker_jwt": "eyJhbGciOiJ...",
  "api_base_url": "https://worker.claude.ai",
  "expires_in": 7200,
  "worker_epoch": 1
}
```

### 3.3 建立 SSE 连接（读取）

```http
GET {api_base_url}/sse
Authorization: Bearer {worker_jwt}
```

- Server 每 15s 发送 keepalive
- 客户端 45s 超时检测
- 自动重连（指数退避，10 分钟预算）

### 3.4 发送消息（写入）

```http
POST {api_base_url}/message
Authorization: Bearer {worker_jwt}
Content-Type: application/json

{"type": "user", "content": "帮我查看当前目录"}
```

### 3.5 JWT 刷新

JWT 有效期约 1-2 小时，需在过期前 5 分钟主动刷新：
- 重新调用 `POST /v1/code/sessions/{id}/bridge`
- 获取新的 `worker_jwt` 和 `worker_epoch`
- **必须重建 SSE 连接**（新 epoch 会使旧连接失效）

---

## 四、消息协议（NDJSON）

每行一个 JSON 对象，通过 SSE 或 WebSocket 传输。

### 4.1 消息类型

**入站（Server → Client）：**
```typescript
// 用户消息
{ type: "user", content: "..." }

// 助手响应
{ type: "assistant", content: "..." }

// 工具执行结果
{ type: "tool_result", tool_use_id: "...", content: "..." }

// 控制请求（权限询问）
{
  type: "control_request",
  request_id: "req_xxx",
  request: {
    subtype: "can_use_tool",
    tool_name: "Bash",
    input: { command: "npm install" }
  }
}

// 保活
{ type: "keep_alive" }
```

**出站（Client → Server）：**
```typescript
// 发送用户消息
{ type: "user", content: "执行 git status" }

// 工具结果回传
{ type: "tool_result", tool_use_id: "...", content: "..." }

// 控制响应（批准/拒绝工具使用）
{
  type: "control_response",
  request_id: "req_xxx",
  response: { type: "approved" }
}

// 会话结果
{ type: "result", content: "..." }
```

### 4.2 Control Protocol（权限控制）

当 Claude 要执行工具时，会发 `control_request`，外部程序需要回复：

| subtype | 说明 |
|---------|------|
| `initialize` | 初始化会话 |
| `set_model` | 设置模型 |
| `can_use_tool` | 请求工具执行权限 |

---

## 五、认证和门控检查链

### 5.1 完整检查流程

```
CLI 启动 remote-control 命令
  ↓
① feature('BRIDGE_MODE') — 编译期门控
  ↓
② isBridgeEnabled()
   ├─ isClaudeAISubscriber() — 检查 OAuth 令牌 + Claude.ai 订阅
   └─ getFeatureValue('tengu_ccr_bridge') — GrowthBook 服务端门控
  ↓
③ checkBridgeMinVersion() — CLI 版本检查
  ↓
④ isPolicyAllowed('allow_remote_control') — 组织级 Policy
  ↓
⑤ bridgeMain() 启动
   ├─ createCodeSession() — POST /v1/code/sessions
   ├─ fetchRemoteCredentials() — POST /v1/code/sessions/{id}/bridge
   ├─ createV2ReplTransport() — SSE 连接
   └─ createTokenRefreshScheduler() — JWT 定时刷新
```

### 5.2 各检查点能否绕过

| 检查 | 位置 | 能否本地绕过 | 说明 |
|------|------|------------|------|
| `feature('BRIDGE_MODE')` | 编译期 | 需重新构建 | 构建时常量 |
| `isClaudeAISubscriber()` | `bridgeEnabled.ts` | 可改返回 true | 但后续 API 调用仍需真实 Token |
| `tengu_ccr_bridge` 门控 | `bridgeEnabled.ts` | 可改默认值 | GrowthBook 缓存值 |
| `checkBridgeMinVersion()` | `bridgeEnabled.ts` | 可跳过 | 版本检查 |
| `isPolicyAllowed()` | `cli.tsx` | 可跳过 | fail-open 设计，无 policy 时默认允许 |
| **服务端 OAuth 验证** | claude.ai 服务器 | **不能** | **服务端鉴权，无法绕过** |
| **服务端 JWT 签发** | claude.ai 服务器 | **不能** | **JWT 由云端签发** |

**结论：本地门控都可以绕过，但云端 API 的 OAuth 和 JWT 验证无法绕过。**

---

## 六、CLI 入口参数

```bash
# Bridge 模式（多个别名）
claude remote-control
claude rc
claude remote
claude sync
claude bridge

# Daemon Worker
claude --daemon-worker=<kind>

# 后台执行
claude --bg
claude --background

# SDK 模式直连
claude --sdk-url <ingress_url>
claude --session-ingress <token>
claude --worker <jwt>

# 后台会话管理
claude ps          # 列出后台会话
claude logs <id>   # 查看日志
claude attach <id> # 附加到会话
claude kill <id>   # 终止会话
```

---

## 七、SSE Transport 实现细节

**文件：** `src/cli/transports/SSETransport.ts`

### 连接参数
- 重连预算：10 分钟
- 活跃超时：45 秒（Server 每 15s 发 keepalive）
- 退避策略：指数退避

### 帧解析
- 标准 SSE 格式（双换行符分隔）
- 字段：`event`, `id`, `data`
- 多行 data 拼接

### 错误处理
| HTTP 状态 | 处理 |
|----------|------|
| 401 | JWT 过期 → 触发刷新回调 |
| 403 | 权限拒绝 → 终止 |
| 404/410 | 会话已删除 → 终止 |
| 其他 4xx/5xx | 致命错误 → 终止 |

---

## 八、RemoteTrigger（定时任务）

**文件：** `src/tools/RemoteTriggerTool/`

通过 API 管理定时远程代理任务：

```http
# 列出所有 trigger
GET /v1/code/triggers

# 创建定时任务
POST /v1/code/triggers
{
  "cron": "0 9 * * *",
  "prompt": "检查项目状态并生成报告",
  ...
}

# 立即执行
POST /v1/code/triggers/{trigger_id}/run

# 更新
POST /v1/code/triggers/{trigger_id}

# 查看详情
GET /v1/code/triggers/{trigger_id}
```

门控：`tengu_surreal_dali` + `allow_remote_sessions` 政策

---

## 九、自建云端远控的设计参考

如果要实现自己的云端远控（替代 claude.ai 中转），需要实现：

### 9.1 中转服务器需要提供的接口

```
POST   /sessions              → 创建会话，返回 session_id
POST   /sessions/{id}/bridge  → 签发 worker_jwt，返回连接信息
GET    /sessions/{id}/sse     → SSE 下行推送通道
POST   /sessions/{id}/message → 上行消息通道
DELETE /sessions/{id}         → 销毁会话
```

### 9.2 核心功能

1. **会话管理** — 创建、维护、销毁会话
2. **JWT 签发** — 为 CLI worker 签发短期 JWT
3. **消息中转** — 外部程序 ↔ 中转服务器 ↔ CLI
4. **SSE 推送** — 实时下行消息流
5. **认证** — 自定义认证替代 OAuth
6. **Keep-alive** — 连接保活机制

### 9.3 CLI 端改造

需要修改的文件：
- `bridge/codeSessionApi.ts` — 替换 API base URL 和认证方式
- `bridge/bridgeEnabled.ts` — 移除订阅和门控检查
- `bridge/remoteBridgeCore.ts` — 适配自定义中转服务器
- `cli/transports/SSETransport.ts` — 适配自定义 SSE 端点
- `entrypoints/cli.tsx` — 移除编译期门控

### 9.4 消息流程图

```
┌──────────────┐     HTTP/WS      ┌──────────────┐     SSE/HTTP     ┌──────────────┐
│   外部程序    │ ──────────────→ │  中转服务器    │ ──────────────→ │ Claude Code  │
│  (Web/App)   │ ←────────────── │  (自建)       │ ←────────────── │    CLI       │
└──────────────┘                  └──────────────┘                  └──────────────┘
      │                                 │                                 │
      │  POST /message                  │  SSE push                      │
      │  "执行 git status"              │  转发到 CLI                     │
      │                                 │                                 │
      │                                 │  control_request               │
      │                                 │  "Bash: git status 是否允许?"   │
      │  control_response               │                                 │
      │  "approved"                     │  转发 approved                  │
      │                                 │                                 │
      │                                 │  assistant 响应                 │
      │  SSE: 执行结果                   │  "当前在 main 分支..."          │
      │                                 │                                 │
```

---

## 十、关键常量和配置

```typescript
// SSE
KEEPALIVE_INTERVAL = 15_000    // Server 发送间隔 (ms)
ACTIVE_TIMEOUT = 45_000        // 客户端超时 (ms)
RECONNECT_BUDGET = 600_000     // 重连预算 (10min)
DEFAULT_KEEP_ALIVE = 120_000   // SDK 模式 keep-alive (ms)

// JWT
TOKEN_REFRESH_BUFFER = 300_000 // 过期前 5 分钟刷新

// 结果
MAX_RESULT_SIZE = 20_000       // 工具结果持久化阈值 (chars)

// 门控标识
BRIDGE_GATE = 'tengu_ccr_bridge'
BRIDGE_V2_GATE = 'tengu_bridge_repl_v2'
TRIGGER_GATE = 'tengu_surreal_dali'
```

---

## 十一、参考：两种 Bridge 版本对比

| 特性 | v1 (Env-based) | v2 (Env-less) |
|------|---------------|---------------|
| 文件 | `bridgeMain.ts` | `remoteBridgeCore.ts` |
| 环境层 | 需要 env_id | 不需要 |
| 连接方式 | 通过 worker/register | 直接 /bridge 获取凭证 |
| 多会话 | 支持（容量管理） | 单会话 |
| 门控 | `tengu_ccr_bridge` | `tengu_bridge_repl_v2` |
| 适用场景 | 完整环境管理 | REPL 轻量交互 |

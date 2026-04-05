# CC-Panes 远程控制详细设计文档

> 版本：v1.0 | 最后更新：2026-04-01

## 1. 概述

### 1.1 目标

为 CC-Panes 提供 HTTP API 远程控制能力，使外部程序（浏览器、脚本、IM 机器人、移动端）能够：

- 创建和管理终端会话（Claude Code 实例）
- 向会话写入输入 / 提交命令
- 实时接收终端输出（SSE 推送）
- 查询项目、工作空间信息

### 1.2 使用场景

| 场景 | 说明 |
|------|------|
| 局域网浏览器控制 | 手机/平板通过浏览器操作 PC 上的 Claude Code |
| IM 机器人集成 | 微信/Slack 机器人转发消息到 Claude Code |
| CI/CD 集成 | 脚本自动化调用 Claude Code 执行任务 |
| 多设备协作 | 同一局域网内多台设备共享 Claude Code 会话 |

### 1.3 与 Claude Code 官方 Bridge 的对比

| 维度 | 官方 Bridge | CC-Panes 方案 |
|------|-----------|--------------|
| 中转架构 | 云端中转（claude.ai） | **本地直连**（CC-Panes 即服务端） |
| 网络模型 | CLI 不开端口，被动连云端 | CC-Panes 开端口，外部直连 |
| 认证 | OAuth + JWT（云端签发） | Bearer Token（本地生成） |
| 适用场景 | 任意网络 | 局域网 / 内网穿透 |
| 延迟 | 高（经云端） | 低（局域网直连） |
| 安全性 | 高（云端鉴权） | 需自行保障（Token + CORS + TLS 可选） |
| 功能范围 | 仅 Claude Code CLI | CC-Panes 全部功能（终端、项目、工作空间） |

### 1.4 可行性分析

CC-Panes 已有基础设施覆盖 ~80%：

| 需要的能力 | 现状 | 差距 |
|-----------|------|------|
| PTY 进程管理 | ✅ portable-pty + 三线程模型 | 无 |
| 会话生命周期 | ✅ 创建/写入/读取/终止 | 无 |
| 实时输出推送 | ✅ EventEmitter trait 已解耦 | 需实现 SSE 适配器 |
| 输出缓冲 | ✅ OutputBuffer 环形缓冲 | 无 |
| HTTP API | ⚠️ OrchestratorService 已实现，绑定 Tauri | 需迁移到 cc-panes-api |
| SSE 推送 | ❌ 未实现 | 新增 |
| 可配置认证 | ⚠️ 已有 Token 认证，但不可配置 | 需增强 |
| 局域网监听 | ❌ 仅绑定 127.0.0.1 | 需可配 bind 地址 |

---

## 2. 架构设计

### 2.1 整体架构

```
┌──────────────────┐     HTTP/SSE      ┌────────────────────────────────┐
│  外部客户端       │ ←───────────────→ │  CC-Panes (本地桌面)            │
│  - 浏览器        │                    │                                │
│  - curl/脚本     │                    │  ┌────────────────────────┐    │
│  - IM 机器人     │                    │  │  cc-panes-api (axum)   │    │
└──────────────────┘                    │  │  ├─ REST API           │    │
                                        │  │  ├─ SSE 推送端点       │    │
                                        │  │  ├─ 认证中间件         │    │
                                        │  │  └─ CORS 中间件       │    │
                                        │  └──────────┬───────────┘    │
                                        │             │                 │
                                        │  ┌──────────┴───────────┐    │
                                        │  │  cc-panes-core        │    │
                                        │  │  ├─ TerminalService   │    │
                                        │  │  ├─ ProjectService    │    │
                                        │  │  └─ WorkspaceService  │    │
                                        │  └──────────┬───────────┘    │
                                        │             │                 │
                                        │        PTY (Claude Code)     │
                                        └────────────────────────────────┘
```

### 2.2 组件职责

| 组件 | 职责 |
|------|------|
| **cc-panes-api** | HTTP 路由、SSE 推送、认证/CORS 中间件、请求验证 |
| **cc-panes-core** | 业务逻辑（终端、项目、工作空间），零框架依赖 |
| **src-tauri** | 启动 HTTP 服务器，注入共享服务实例，UI 控制面板 |

### 2.3 数据流

#### 创建会话并获取输出

```
Client                    cc-panes-api              cc-panes-core
  │                           │                          │
  │  POST /api/sessions       │                          │
  │ ─────────────────────────→│                          │
  │                           │  create_session()        │
  │                           │ ────────────────────────→│
  │                           │       session_id         │
  │                           │←────────────────────────│
  │  { session_id }           │                          │
  │←─────────────────────────│                          │
  │                           │                          │
  │  GET /api/sessions/{id}/stream (SSE)                 │
  │ ─────────────────────────→│                          │
  │                           │  subscribe(session_id)   │
  │                           │ ────────────────────────→│
  │   event: output           │                          │
  │   data: { ... }           │     broadcast output     │
  │←─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│←─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│
  │   event: output           │                          │
  │   data: { ... }           │                          │
  │←─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│                          │
```

#### 写入输入

```
Client                    cc-panes-api              cc-panes-core
  │                           │                          │
  │  POST /sessions/{id}/input│                          │
  │ ─────────────────────────→│                          │
  │                           │  write(session_id, data) │
  │                           │ ────────────────────────→│
  │                           │       ok                 │
  │                           │←────────────────────────│
  │  204 No Content           │                          │
  │←─────────────────────────│                          │
```

### 2.4 与现有 OrchestratorService 的关系

现有 `OrchestratorService`（src-tauri）已实现 9 个 REST 端点 + MCP Server，但耦合 Tauri（`AppHandle`、`Emitter`）。

**迁移策略**：

1. **阶段 1**：在 cc-panes-api 中重新实现 REST 端点，直接调用 cc-panes-core 服务
2. **阶段 2**：OrchestratorService 的 REST 路由逐步委托给 cc-panes-api
3. **最终态**：OrchestratorService 仅保留 MCP Server 部分（需要 Tauri `AppHandle`），REST API 完全由 cc-panes-api 提供

> 注意：MCP Server 功能（`/mcp` 端点）因依赖 Tauri GUI 操作（打开标签、切换面板），将继续留在 src-tauri 中。

---

## 3. REST API 规范

### 3.1 通用约定

- **Base URL**: `http://{host}:{port}`（默认 `http://127.0.0.1:3200`）
- **Content-Type**: `application/json`
- **认证**: `Authorization: Bearer {token}`（所有端点均需认证，除 `GET /api/health`）
- **错误响应格式**:

```json
{
  "error": "错误描述",
  "code": "ERROR_CODE"
}
```

### 3.2 通用状态码

| 状态码 | 含义 |
|--------|------|
| 200 | 成功 |
| 201 | 创建成功 |
| 204 | 操作成功，无响应体 |
| 400 | 请求参数错误 |
| 401 | 未认证 / Token 无效 |
| 404 | 资源不存在 |
| 429 | 请求频率超限 |
| 500 | 服务器内部错误 |

### 3.3 会话管理

#### 3.3.1 创建会话

创建新的终端会话，可选启动 Claude Code CLI。

```
POST /api/sessions
```

**请求体**:

```json
{
  "projectPath": "/path/to/project",
  "cols": 120,
  "rows": 30,
  "cliTool": "claude",
  "resumeId": null,
  "workspaceName": "my-workspace",
  "providerId": "provider-1",
  "prompt": "帮我分析这个项目的架构",
  "skipMcp": false
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| projectPath | string | ✅ | 项目路径（必须是已注册项目） |
| cols | number | 否 | 终端列数，默认 120 |
| rows | number | 否 | 终端行数，默认 30 |
| cliTool | string | 否 | CLI 工具：`"claude"` / `"codex"` / `"none"`，默认 `"none"` |
| resumeId | string | 否 | 恢复会话 UUID（与 prompt 互斥） |
| workspaceName | string | 否 | 工作空间名称 |
| providerId | string | 否 | API Provider ID |
| prompt | string | 否 | 初始 prompt（与 resumeId 互斥） |
| skipMcp | boolean | 否 | 跳过 MCP 配置注入，默认 false |

**响应** `201 Created`:

```json
{
  "sessionId": "a1b2c3d4-e5f6-...",
  "status": "running"
}
```

**错误**:
- `400` — projectPath 未注册、prompt 和 resumeId 同时提供/均缺失
- `429` — 频率限制

#### 3.3.2 列出会话

```
GET /api/sessions
```

**响应** `200 OK`:

```json
{
  "sessions": [
    {
      "sessionId": "a1b2c3d4-...",
      "projectPath": "/path/to/project",
      "status": "running",
      "cliTool": "claude",
      "createdAt": "2026-04-01T10:00:00Z",
      "lastOutputAt": "2026-04-01T10:05:00Z"
    }
  ]
}
```

#### 3.3.3 获取会话状态

```
GET /api/sessions/{sessionId}/status
```

**响应** `200 OK`:

```json
{
  "sessionId": "a1b2c3d4-...",
  "status": "running",
  "exitCode": null,
  "cliTool": "claude",
  "projectPath": "/path/to/project"
}
```

`status` 枚举值：`"running"` | `"waiting_input"` | `"exited"`

#### 3.3.4 终止会话

```
DELETE /api/sessions/{sessionId}
```

**响应** `204 No Content`

**错误**:
- `404` — 会话不存在

### 3.4 输入写入

#### 3.4.1 写入原始字节

向终端写入原始数据，不做任何处理。适用于发送控制字符（如 `\x03` = Ctrl+C）。

```
POST /api/sessions/{sessionId}/write
```

**请求体**:

```json
{
  "data": "ls -la\n"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| data | string | ✅ | 原始数据（可包含控制字符，如 `"\x03"` 表示 Ctrl+C） |

**响应** `204 No Content`

#### 3.4.2 提交文本（Submit）

向终端提交文本，自动处理 Enter 键时序（先写入文本，延迟 150ms，再发送 Enter）。适用于向 Claude Code 提交 prompt 或 slash command。

```
POST /api/sessions/{sessionId}/submit
```

**请求体**:

```json
{
  "text": "/plan 分析项目架构"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| text | string | ✅ | 要提交的文本（不含换行符） |

**响应** `204 No Content`

### 3.5 输出读取

#### 3.5.1 轮询获取输出

获取会话的最近输出内容（从环形缓冲区读取）。

```
GET /api/sessions/{sessionId}/output?lines=100
```

| 查询参数 | 类型 | 必填 | 说明 |
|----------|------|------|------|
| lines | number | 否 | 返回最近 N 行，默认 100，最大 500 |

**响应** `200 OK`:

```json
{
  "sessionId": "a1b2c3d4-...",
  "output": "$ claude\nWelcome to Claude Code...\n",
  "lineCount": 42,
  "status": "running"
}
```

#### 3.5.2 SSE 实时推送

通过 Server-Sent Events 实时接收终端输出。详见 [第 4 章 SSE 推送协议](#4-sse-推送协议)。

```
GET /api/sessions/{sessionId}/stream
```

### 3.6 项目与工作空间

#### 3.6.1 列出项目

```
GET /api/projects
```

**响应** `200 OK`:

```json
{
  "projects": [
    {
      "id": "proj-123",
      "name": "cc-panes",
      "path": "/home/user/cc-panes",
      "workspaceName": "dev"
    }
  ]
}
```

#### 3.6.2 列出工作空间

```
GET /api/workspaces
```

**响应** `200 OK`:

```json
{
  "workspaces": [
    {
      "name": "dev",
      "projects": [
        { "id": "proj-123", "name": "cc-panes", "path": "/home/user/cc-panes" }
      ]
    }
  ]
}
```

### 3.7 健康检查

无需认证。

```
GET /api/health
```

**响应** `200 OK`:

```json
{
  "status": "ok",
  "version": "0.9.30",
  "uptime": 3600,
  "sessions": {
    "active": 3,
    "total": 5
  }
}
```

### 3.8 远程控制管理

#### 3.8.1 获取远程控制状态

```
GET /api/remote/status
```

**响应** `200 OK`:

```json
{
  "enabled": true,
  "port": 3200,
  "bindAddress": "0.0.0.0",
  "connectedClients": 2,
  "localIp": "192.168.1.100"
}
```

#### 3.8.2 重新生成 Token

```
POST /api/remote/regenerate-token
```

**响应** `200 OK`:

```json
{
  "token": "new-random-token-string"
}
```

> 注意：所有使用旧 Token 的客户端将立即失效，需要重新认证。

---

## 4. SSE 推送协议

### 4.1 端点

```
GET /api/sessions/{sessionId}/stream
Authorization: Bearer {token}
Accept: text/event-stream
```

### 4.2 事件类型

#### 4.2.1 `output` — 终端输出

```
event: output
data: {"sessionId":"a1b2c3d4-...","data":"$ ls\nREADME.md\nsrc/\n","timestamp":"2026-04-01T10:05:00.123Z"}

```

| 字段 | 类型 | 说明 |
|------|------|------|
| sessionId | string | 会话 ID |
| data | string | 终端输出内容（可能包含 ANSI 转义序列） |
| timestamp | string | ISO 8601 时间戳 |

#### 4.2.2 `status` — 状态变更

```
event: status
data: {"sessionId":"a1b2c3d4-...","status":"waiting_input","timestamp":"2026-04-01T10:05:01Z"}

```

| status 值 | 说明 |
|-----------|------|
| running | 正在执行 |
| waiting_input | 等待用户输入 |
| exited | 已退出 |

#### 4.2.3 `exit` — 会话退出

```
event: exit
data: {"sessionId":"a1b2c3d4-...","exitCode":0,"timestamp":"2026-04-01T10:10:00Z"}

```

#### 4.2.4 `keepalive` — 心跳

服务端每 15 秒发送一次心跳，防止连接超时。

```
: keepalive

```

> 注意：SSE 标准中以 `:` 开头的行是注释，客户端应忽略但连接保持活跃。

### 4.3 连接管理

#### 初始连接

建立 SSE 连接后，服务端立即发送一个 `connected` 事件确认连接成功：

```
event: connected
data: {"sessionId":"a1b2c3d4-...","bufferLines":100}

```

`bufferLines` 告知客户端可通过 `GET /api/sessions/{id}/output?lines=100` 获取历史输出。

#### 断线重连

客户端应使用 `Last-Event-ID` 头实现断线重连：

```
GET /api/sessions/{sessionId}/stream
Authorization: Bearer {token}
Last-Event-ID: 42
```

服务端为每个 `output` 事件分配递增 ID：

```
id: 42
event: output
data: {"sessionId":"a1b2c3d4-...","data":"hello\n","timestamp":"..."}

```

重连时，服务端从 `Last-Event-ID` 之后的事件开始推送。若 ID 过旧（超出缓冲区），返回全部可用缓冲。

#### 连接关闭

以下情况 SSE 连接关闭：
- 会话退出（发送 `exit` 事件后关闭）
- 客户端主动断开
- Token 失效（服务端发送 `error` 事件后关闭）

```
event: error
data: {"code":"TOKEN_EXPIRED","message":"Token has been regenerated"}

```

### 4.4 实现方案

#### SseEmitter

实现 `EventEmitter` trait，通过 `tokio::sync::broadcast` 广播终端事件：

```rust
// cc-panes-api/src/emitter.rs

use cc_panes_core::events::EventEmitter;
use tokio::sync::broadcast;

pub struct SseEmitter {
    tx: broadcast::Sender<SseEvent>,
}

pub struct SseEvent {
    pub event_type: String,   // "output" | "status" | "exit"
    pub session_id: String,
    pub data: serde_json::Value,
    pub id: u64,
}

impl EventEmitter for SseEmitter {
    fn emit(&self, event: &str, payload: serde_json::Value) -> anyhow::Result<()> {
        let _ = self.tx.send(SseEvent {
            event_type: event.to_string(),
            session_id: extract_session_id(&payload),
            data: payload,
            id: next_id(),
        });
        Ok(())
    }
}
```

#### SSE 路由

```rust
// cc-panes-api/src/routes/sse.rs

async fn handle_session_stream(
    Path(session_id): Path<String>,
    State(state): State<ApiState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let mut rx = state.sse_emitter.subscribe(session_id);

    let stream = async_stream::stream! {
        // 发送 connected 事件
        yield Ok(Event::default()
            .event("connected")
            .data(json!({"sessionId": session_id}).to_string()));

        // 发送 keepalive + 输出事件
        let mut keepalive = tokio::time::interval(Duration::from_secs(15));
        loop {
            tokio::select! {
                Ok(event) = rx.recv() => {
                    yield Ok(Event::default()
                        .event(&event.event_type)
                        .id(event.id.to_string())
                        .data(event.data.to_string()));

                    if event.event_type == "exit" {
                        break;
                    }
                }
                _ = keepalive.tick() => {
                    yield Ok(Event::default().comment("keepalive"));
                }
            }
        }
    };

    Sse::new(stream).keep_alive(KeepAlive::default())
}
```

---

## 5. 认证与安全模型

### 5.1 Token 认证

#### 生成

- 应用启动时（或用户首次开启远程控制时）生成一个 32 字节随机 Token
- 使用 `rand::thread_rng()` + Base62 编码
- Token 持久化到配置文件，重启不变（除非用户手动重新生成）

#### 传递方式

所有 API 请求（除 `GET /api/health`）须携带 Token：

```
Authorization: Bearer {token}
```

#### 验证流程

```
Request → Auth Middleware
  ├─ /api/health → 放行
  ├─ 检查 Authorization header
  │   ├─ 匹配 → 放行
  │   └─ 不匹配 → 401 Unauthorized
  └─ 无 Authorization header → 401 Unauthorized
```

### 5.2 axum 中间件

```rust
// cc-panes-api/src/middleware/auth.rs

pub async fn auth_middleware(
    State(state): State<ApiState>,
    request: Request,
    next: Next,
) -> Response {
    // 健康检查不需要认证
    if request.uri().path() == "/api/health" {
        return next.run(request).await;
    }

    let token_valid = request
        .headers()
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|t| t == state.token)
        .unwrap_or(false);

    if !token_valid {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "Invalid or missing Bearer token", "code": "UNAUTHORIZED"})),
        ).into_response();
    }

    next.run(request).await
}
```

### 5.3 CORS 配置

远程控制模式下 CORS 需比 OrchestratorService 更宽松：

| 模式 | CORS 策略 |
|------|-----------|
| 仅本地（默认） | `allow_origin`: localhost / 127.0.0.1 |
| 局域网 | `allow_origin`: 同一子网 IP 段（如 `192.168.*.*`） |
| 全部允许 | `allow_origin`: `*`（需用户确认风险） |

```rust
fn build_cors(config: &RemoteControlConfig) -> CorsLayer {
    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
        .allow_headers(Any);

    match config.cors_mode {
        CorsMode::LocalOnly => cors.allow_origin(/* localhost predicate */),
        CorsMode::Lan => cors.allow_origin(AllowOrigin::predicate(is_lan_origin)),
        CorsMode::Any => cors.allow_origin(Any),
    }
}
```

### 5.4 频率限制

沿用现有方案：滑动窗口限流。

- 窗口：10 秒
- 最大请求数：20（可配置）
- 超限返回 `429 Too Many Requests`

### 5.5 安全考量

#### 局域网场景

- Token 通过 UI 展示（Settings 面板），用户手动复制到客户端
- 建议同一局域网内使用，不暴露到公网
- 可选生成二维码（包含 URL + Token），方便手机扫码连接

#### 进阶安全（可选）

- **TLS**：支持自签证书 HTTPS（`axum_server` + `rustls`）
- **IP 白名单**：限制允许连接的 IP 地址
- **Token 过期**：可配置 Token 有效期（默认不过期）
- **操作审计日志**：记录所有远程操作到日志文件

---

## 6. 消息格式

### 6.1 JSON 消息类型定义

所有 API 响应均使用 JSON 格式。以下为核心数据类型定义。

#### SessionInfo

```typescript
interface SessionInfo {
  sessionId: string;
  projectPath: string;
  status: "running" | "waiting_input" | "exited";
  cliTool: "claude" | "codex" | "none";
  exitCode: number | null;
  createdAt: string;      // ISO 8601
  lastOutputAt: string;   // ISO 8601
}
```

#### SessionOutput

```typescript
interface SessionOutput {
  sessionId: string;
  output: string;         // 终端输出内容（含 ANSI 转义序列）
  lineCount: number;
  status: "running" | "waiting_input" | "exited";
}
```

#### CreateSessionRequest

```typescript
interface CreateSessionRequest {
  projectPath: string;
  cols?: number;          // 默认 120
  rows?: number;          // 默认 30
  cliTool?: "claude" | "codex" | "none";  // 默认 "none"
  resumeId?: string;      // 与 prompt 互斥
  workspaceName?: string;
  providerId?: string;
  prompt?: string;        // 与 resumeId 互斥
  skipMcp?: boolean;      // 默认 false
}
```

#### CreateSessionResponse

```typescript
interface CreateSessionResponse {
  sessionId: string;
  status: "running";
}
```

#### WriteRequest

```typescript
interface WriteRequest {
  data: string;           // 原始数据
}
```

#### SubmitRequest

```typescript
interface SubmitRequest {
  text: string;           // 文本内容（不含换行符）
}
```

#### SSE 事件数据

```typescript
// event: output
interface OutputEvent {
  sessionId: string;
  data: string;
  timestamp: string;
}

// event: status
interface StatusEvent {
  sessionId: string;
  status: "running" | "waiting_input" | "exited";
  timestamp: string;
}

// event: exit
interface ExitEvent {
  sessionId: string;
  exitCode: number;
  timestamp: string;
}

// event: error
interface ErrorEvent {
  code: string;
  message: string;
}
```

#### ApiError

```typescript
interface ApiError {
  error: string;
  code: string;
}
```

### 6.2 与 OrchestratorService 的兼容性

新 API 与现有 OrchestratorService REST 端点的映射：

| 现有端点 | 新端点 | 变化 |
|---------|--------|------|
| `POST /api/launch-task` | `POST /api/sessions` | 简化请求体，移除 UI 相关字段（paneId, title） |
| `GET /api/sessions` | `GET /api/sessions` | 响应格式统一 |
| `GET /api/session-status/{id}` | `GET /api/sessions/{id}/status` | RESTful 路径 |
| `POST /api/write-to-session` | `POST /api/sessions/{id}/write` | 路径参数化 |
| `POST /api/submit-to-session` | `POST /api/sessions/{id}/submit` | 路径参数化 |
| `POST /api/kill-session` | `DELETE /api/sessions/{id}` | HTTP 语义化 |
| `GET /api/projects` | `GET /api/projects` | 不变 |
| `GET /api/health` | `GET /api/health` | 增加更多信息 |
| _新增_ | `GET /api/sessions/{id}/output` | 轮询输出 |
| _新增_ | `GET /api/sessions/{id}/stream` | SSE 实时推送 |
| _新增_ | `GET /api/workspaces` | 工作空间查询 |
| _新增_ | `GET /api/remote/status` | 远程控制状态 |
| _新增_ | `POST /api/remote/regenerate-token` | 重新生成 Token |

---

## 7. 前端 UI — Remote Control 设置面板

### 7.1 Settings 面板新增 "Remote Control" Tab

在现有 Settings 面板（通用、终端、快捷键、代理、Provider、关于）中新增 **"Remote Control"** 标签页。

### 7.2 UI 布局

```
┌─ Remote Control ─────────────────────────────────────────┐
│                                                           │
│  ┌─ Server ──────────────────────────────────────────┐   │
│  │  启用远程控制    [  Toggle Switch  ]               │   │
│  │                                                    │   │
│  │  监听地址        [ 0.0.0.0      ▼ ]               │   │
│  │                  ○ 127.0.0.1（仅本机）             │   │
│  │                  ● 0.0.0.0（局域网）               │   │
│  │                                                    │   │
│  │  端口            [ 3200          ]                 │   │
│  │                                                    │   │
│  │  CORS 模式       [ 局域网        ▼ ]               │   │
│  │                  ○ 仅本地                          │   │
│  │                  ○ 局域网                          │   │
│  │                  ○ 全部允许（不推荐）               │   │
│  └────────────────────────────────────────────────────┘   │
│                                                           │
│  ┌─ Authentication ──────────────────────────────────┐   │
│  │  访问令牌        [ •••••••••••• ] [复制] [重新生成] │   │
│  │                                                    │   │
│  │  频率限制        [ 20 ] 次 / 10 秒                 │   │
│  └────────────────────────────────────────────────────┘   │
│                                                           │
│  ┌─ Connection Info ─────────────────────────────────┐   │
│  │  状态            🟢 运行中 (端口 3200)             │   │
│  │  局域网 IP       192.168.1.100                     │   │
│  │                                                    │   │
│  │  连接地址        http://192.168.1.100:3200         │   │
│  │                  [复制完整 URL]                     │   │
│  │                                                    │   │
│  │  ┌──────────┐                                      │   │
│  │  │  QR Code │  扫码快速连接                        │   │
│  │  │          │  （含 URL + Token）                  │   │
│  │  └──────────┘                                      │   │
│  │                                                    │   │
│  │  已连接客户端    2 个活跃连接                       │   │
│  └────────────────────────────────────────────────────┘   │
│                                                           │
└───────────────────────────────────────────────────────────┘
```

### 7.3 交互逻辑

| 操作 | 行为 |
|------|------|
| 开启 Toggle | 启动 HTTP 服务器，绑定配置的地址和端口 |
| 关闭 Toggle | 停止 HTTP 服务器，断开所有 SSE 连接 |
| 修改端口 | 需要重启服务器生效（提示用户） |
| 修改监听地址 | 需要重启服务器生效 |
| 复制 Token | 复制到剪贴板 |
| 重新生成 Token | 生成新 Token，所有现有连接失效 |
| 复制完整 URL | 复制 `http://{ip}:{port}` 到剪贴板 |

### 7.4 二维码

二维码内容为 JSON 编码的连接信息：

```json
{
  "url": "http://192.168.1.100:3200",
  "token": "bearer-token-string"
}
```

客户端（浏览器/App）扫码后解析 JSON，自动填充连接配置。

---

## 8. 实现路径

### 8.1 阶段 1：cc-panes-api HTTP 服务（核心）

**目标**：让 cc-panes-api 从骨架变为可用的 HTTP 服务

**任务**：

1. **定义 ApiState**（共享状态结构）
   - 文件：`cc-panes-api/src/state.rs`
   - 包含 `Arc<TerminalService>`, `Arc<ProjectService>`, `Arc<WorkspaceService>`, Token 等

2. **实现 REST 路由**
   - 文件：`cc-panes-api/src/routes/sessions.rs` — 会话 CRUD
   - 文件：`cc-panes-api/src/routes/projects.rs` — 项目查询
   - 文件：`cc-panes-api/src/routes/health.rs` — 健康检查
   - 文件：`cc-panes-api/src/routes/mod.rs` — 路由聚合

3. **实现认证中间件**
   - 文件：`cc-panes-api/src/middleware/auth.rs`

4. **构建 Router**
   - 文件：`cc-panes-api/src/lib.rs` — 公开 `build_router(state) -> Router`

5. **在 Tauri setup 中启动**
   - 文件：`src-tauri/src/lib.rs` — setup 中创建 ApiState，启动 axum 服务器
   - 与现有 OrchestratorService 共享 cc-panes-core 服务实例

**关键依赖**：
```toml
# cc-panes-api/Cargo.toml
[dependencies]
cc-panes-core = { path = "../cc-panes-core" }
axum = "0.8"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tower-http = { version = "0.6", features = ["cors"] }
tracing = "0.1"
```

### 8.2 阶段 2：SSE 实时推送

**目标**：外部客户端能实时接收终端输出

**任务**：

1. **实现 SseEmitter**
   - 文件：`cc-panes-api/src/emitter.rs`
   - 实现 `EventEmitter` trait
   - 内部使用 `tokio::sync::broadcast` 广播事件

2. **实现 SSE 路由**
   - 文件：`cc-panes-api/src/routes/sse.rs`
   - `GET /api/sessions/{id}/stream` — SSE 订阅
   - 支持 keepalive、断线重连（Last-Event-ID）

3. **注入 SseEmitter 到 TerminalService**
   - 在 Tauri setup 中，通过 `TerminalService::set_emitter()` 注入
   - SseEmitter 与 TauriEmitter 可以共存（使用组合 Emitter 同时广播到两端）

**组合 Emitter 设计**：
```rust
// cc-panes-core 中定义
pub struct CompositeEmitter {
    emitters: Vec<Arc<dyn EventEmitter>>,
}

impl EventEmitter for CompositeEmitter {
    fn emit(&self, event: &str, payload: Value) -> anyhow::Result<()> {
        for emitter in &self.emitters {
            let _ = emitter.emit(event, payload.clone());
        }
        Ok(())
    }
}
```

### 8.3 阶段 3：认证增强与安全

**目标**：防止未授权访问，支持局域网安全配置

**任务**：

1. **Token 持久化**
   - 存储到配置文件（`~/.cc-panes/config.toml` 的 `[remote_control]` 段）
   - 支持重新生成

2. **可配置 CORS**
   - 根据 `cors_mode` 动态构建 CORS 中间件

3. **可配置 bind 地址**
   - 默认 `127.0.0.1`（仅本地），可切换为 `0.0.0.0`（局域网）

4. **频率限制增强**
   - 可配置窗口大小和最大请求数

### 8.4 阶段 4：前端 Settings 面板

**目标**：提供可视化的远程控制配置界面

**任务**：

1. **新增 RemoteControlSettings 组件**
   - 文件：`web/components/settings/RemoteControlSettings.tsx`

2. **Zustand Store**
   - 文件：`web/stores/useRemoteControlStore.ts`

3. **Service 层**
   - 文件：`web/services/remoteControlService.ts` — invoke 封装

4. **Tauri Command**
   - 文件：`src-tauri/src/commands/remote_control_commands.rs`

5. **二维码生成**
   - 前端使用 `qrcode` npm 包生成 SVG 二维码

### 8.5 阶段 5（可选）：Web 控制面板

**目标**：浏览器端远程控制 UI

- 独立的 HTML + JS 页面（xterm.js + EventSource API）
- 通过 cc-panes-api 的静态文件服务提供
- 类似 CCPad 的局域网终端功能

---

## 9. 配置项

### 9.1 配置文件

位于 `~/.cc-panes/config.toml`（Release）或 `~/.cc-panes-dev/config.toml`（Dev）:

```toml
[remote_control]
# 是否启用远程控制 HTTP 服务器
enabled = false

# 监听地址
# "127.0.0.1" — 仅本机访问
# "0.0.0.0" — 局域网访问
bind_address = "127.0.0.1"

# 监听端口（0 = 自动分配）
port = 3200

# 认证 Token（首次启动自动生成）
token = ""

# CORS 模式
# "local" — 仅 localhost/127.0.0.1
# "lan" — 局域网 IP
# "any" — 全部允许（不推荐）
cors_mode = "local"

# 频率限制
rate_limit_window_secs = 10
rate_limit_max_requests = 20
```

### 9.2 Rust 配置结构

```rust
// cc-panes-core/src/models/remote_control.rs

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteControlConfig {
    pub enabled: bool,
    pub bind_address: String,
    pub port: u16,
    pub token: String,
    pub cors_mode: CorsMode,
    pub rate_limit_window_secs: u64,
    pub rate_limit_max_requests: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CorsMode {
    Local,
    Lan,
    Any,
}

impl Default for RemoteControlConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            bind_address: "127.0.0.1".to_string(),
            port: 3200,
            token: generate_random_token(),
            cors_mode: CorsMode::Local,
            rate_limit_window_secs: 10,
            rate_limit_max_requests: 20,
        }
    }
}
```

### 9.3 TypeScript 类型

```typescript
// web/types/remote-control.ts

interface RemoteControlConfig {
  enabled: boolean;
  bindAddress: string;
  port: number;
  token: string;
  corsMode: "local" | "lan" | "any";
  rateLimitWindowSecs: number;
  rateLimitMaxRequests: number;
}

interface RemoteControlStatus {
  enabled: boolean;
  port: number;
  bindAddress: string;
  connectedClients: number;
  localIp: string;
}
```

### 9.4 环境变量覆盖

支持通过环境变量覆盖配置（优先级高于配置文件）：

| 环境变量 | 说明 |
|---------|------|
| `CCPANES_REMOTE_ENABLED` | 启用/禁用 (`true`/`false`) |
| `CCPANES_REMOTE_PORT` | 端口号 |
| `CCPANES_REMOTE_BIND` | 监听地址 |
| `CCPANES_REMOTE_TOKEN` | 固定 Token |

---

## 附录 A：完整 API 端点索引

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| GET | `/api/health` | 否 | 健康检查 |
| POST | `/api/sessions` | 是 | 创建会话 |
| GET | `/api/sessions` | 是 | 列出会话 |
| GET | `/api/sessions/{id}/status` | 是 | 获取会话状态 |
| DELETE | `/api/sessions/{id}` | 是 | 终止会话 |
| POST | `/api/sessions/{id}/write` | 是 | 写入原始数据 |
| POST | `/api/sessions/{id}/submit` | 是 | 提交文本 |
| GET | `/api/sessions/{id}/output` | 是 | 获取输出（轮询） |
| GET | `/api/sessions/{id}/stream` | 是 | SSE 实时推送 |
| GET | `/api/projects` | 是 | 列出项目 |
| GET | `/api/workspaces` | 是 | 列出工作空间 |
| GET | `/api/remote/status` | 是 | 远程控制状态 |
| POST | `/api/remote/regenerate-token` | 是 | 重新生成 Token |

## 附录 B：curl 使用示例

```bash
# 设置 Token
TOKEN="your-token-here"
BASE="http://192.168.1.100:3200"

# 健康检查
curl $BASE/api/health

# 创建会话并启动 Claude
curl -X POST $BASE/api/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"projectPath":"/home/user/my-project","cliTool":"claude","prompt":"分析项目架构"}'

# 列出会话
curl $BASE/api/sessions -H "Authorization: Bearer $TOKEN"

# 获取输出
curl "$BASE/api/sessions/SESSION_ID/output?lines=50" -H "Authorization: Bearer $TOKEN"

# 提交输入
curl -X POST $BASE/api/sessions/SESSION_ID/submit \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"/plan 重构认证模块"}'

# SSE 实时监听
curl -N $BASE/api/sessions/SESSION_ID/stream -H "Authorization: Bearer $TOKEN"

# 发送 Ctrl+C
curl -X POST $BASE/api/sessions/SESSION_ID/write \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"data":"\u0003"}'

# 终止会话
curl -X DELETE $BASE/api/sessions/SESSION_ID -H "Authorization: Bearer $TOKEN"
```

## 附录 C：JavaScript SSE 客户端示例

```javascript
const BASE = "http://192.168.1.100:3200";
const TOKEN = "your-token-here";

// 创建 SSE 连接（使用 fetch + ReadableStream，因为 EventSource 不支持自定义 header）
async function connectSSE(sessionId) {
  const response = await fetch(`${BASE}/api/sessions/${sessionId}/stream`, {
    headers: { "Authorization": `Bearer ${TOKEN}` },
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    const text = decoder.decode(value);
    // 解析 SSE 事件
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        const data = JSON.parse(line.slice(6));
        console.log("Event:", data);
      }
    }
  }
}

// 或使用 eventsource-polyfill（支持自定义 header）
import { EventSourcePolyfill } from "eventsource-polyfill";

const es = new EventSourcePolyfill(`${BASE}/api/sessions/${sessionId}/stream`, {
  headers: { "Authorization": `Bearer ${TOKEN}` },
});

es.addEventListener("output", (e) => {
  const data = JSON.parse(e.data);
  terminal.write(data.data);  // 写入 xterm.js
});

es.addEventListener("status", (e) => {
  const data = JSON.parse(e.data);
  console.log("Status:", data.status);
});

es.addEventListener("exit", (e) => {
  const data = JSON.parse(e.data);
  console.log("Session exited with code:", data.exitCode);
  es.close();
});
```

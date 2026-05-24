---
name: launch-task
description: CC-Panes 项目维护者手册 — 启动 Claude/Codex 任务的高级流程（WSL、resume、PTY 交互、leader/worker 编排、REST fallback）。基础启动用全局 ccpanes:launch-task；遇到 worktree/恢复/卡住/排障来本 skill。
trigger: |
  - 用户在 cc-book 项目内说"启动 Claude/Codex"、"开个新窗口"、"在 X 项目跑个任务"
  - 用户问"恢复昨天那个 Codex"、"resume 之前的会话"
  - 启动后要做 PTY 交互（提交命令、读输出、终止）
  - 想用 leader/worker 自动反馈机制
---

# launch-task — CC-Panes 启动任务（高级流程）

cc-panes 通过 MCP 工具与本地/WSL/SSH 上的 Claude/Codex 实例交互。本 skill 是 **cc-book 项目维护者手册**，覆盖：WSL 启动、resume、PTY 交互、leader/worker 编排、REST fallback。

> **基础"启动一个新窗口"用全局 `ccpanes:launch-task` 就够了。** 本项目版专注高级编排和排障。

> **MCP 工具总数 69 个**（按 src-tauri/src/services/orchestrator_service.rs 中 `#[tool]` 计数），下面只列与启动/会话/编排相关的核心。完整列表用 `tools/list` 查 ccpanes MCP server。

---

## 核心工具表（按用途分组）

### 启动 / 项目

| 工具 | 关键参数 | 备注 |
|------|---------|------|
| `mcp__ccpanes__launch_task` | `projectPath`（必填）, `prompt?`, `resumeId?`, `cliTool?`, `providerId?`, `providerSelection?`, `workspaceName?`, `runtimeKind?`, `title?`, `paneId?` | `prompt` 与 `resumeId` **互斥**。`cliTool` 只接 `claude` / `codex` |
| `mcp__ccpanes__list_projects` | — | 取已注册项目原样路径（WSL 启动必须用） |
| `mcp__ccpanes__add_project_to_workspace` | `workspaceName`, `projectPath` | 注册新项目 |
| `mcp__ccpanes__scan_directory` | `path` | 扫目录发现 Git 仓库 |

### Session / PTY 交互（启动后必用）

| 工具 | 用途 |
|------|------|
| `mcp__ccpanes__get_session_status` | 当前状态（active / thinking / waitingInput / idle / exited / error 等） |
| `mcp__ccpanes__get_session_output` | 读 PTY 缓冲 |
| `mcp__ccpanes__submit_to_session` | 提交命令/prompt（自动处理回车时序，**最常用**） |
| `mcp__ccpanes__write_to_session` | 写原始字节（Ctrl+C = `"\x03"` 等控制符） |
| `mcp__ccpanes__list_sessions` | 列所有活跃 session |
| `mcp__ccpanes__kill_session` | 终止 session |
| `mcp__ccpanes__list_panes` | 列 UI 面板（找已有窗口） |
| `mcp__ccpanes__get_task_status` | **仅启动事件检查**，不要拿来轮询 worker 完成 |

### Resume / 历史

| 工具 | 用途 |
|------|------|
| `mcp__ccpanes__list_launch_history` | 历史启动记录（含 `resumeSessionId/cliTool/runtimeKind/projectPath/lastPrompt`）|
| `mcp__ccpanes__list_resume_sessions` | Claude/Codex 可恢复历史会话（按 cliTool 过滤）|

### Leader / Worker 编排（异步任务核心）

| 工具 | 用途 |
|------|------|
| `mcp__ccpanes__register_plan_leader` | 把当前 Claude 标记为 leader |
| `mcp__ccpanes__register_plan_worker` | 把启动的 Codex/Claude 实例绑定为 worker |
| `mcp__ccpanes__report_to_leader` | worker 完成时 PTY 推送给 leader（leader busy 会丢，见下方） |
| `mcp__ccpanes__update_task_binding` | 持久化 worker 状态（**必做** —— PTY 反馈丢失时的兜底）|
| `mcp__ccpanes__reconcile_plan_collaboration` | leader 端最终兜底，扫所有 worker binding 最终状态 |

### Workspace

| 工具 | 用途 |
|------|------|
| `list_workspaces` / `get_workspace` / `create_workspace` | workspace CRUD |

### Todo（与 launch-task 不直接相关，列出供参考）

| 工具 | 字段 |
|------|------|
| `query_todos` | 不支持 `todoType` filter |
| `create_todo` | 不支持 `todoType` 字段 |
| `update_todo` | 字段 `id / status / title / priority / description`（**没有 `completed`**）|

---

## 典型工作流

### A. 启动新任务

```
1. mcp__ccpanes__list_projects           # 取已注册项目路径（WSL 启动必须用其中字符串原样）
2. mcp__ccpanes__launch_task(...)         # 启动，记录 sessionId / taskId
3. mcp__ccpanes__get_session_status(...) # 看启动是否成功（status=active/thinking 即正常）
4. mcp__ccpanes__get_session_output(...) # 读输出确认 prompt 已注入
```

> **注意**：旧 skill 写的 `launch_task → get_task_status → 等完成` 是错的。`get_task_status` 只查启动事件；任务进度看 `get_session_status` + `get_session_output`。

### B. 后续 PTY 交互

```
# 发新命令（最常用，自动处理回车）
mcp__ccpanes__submit_to_session(sessionId, text="<prompt>")

# 发原始控制符（如 Ctrl+C）
mcp__ccpanes__write_to_session(sessionId, text="\x03")

# 读输出
mcp__ccpanes__get_session_output(sessionId, lines=200)

# 终止
mcp__ccpanes__kill_session(sessionId)
```

### C. 恢复昨天那个 Codex / Claude

```
1. mcp__ccpanes__list_launch_history(projectPath=...)
   # 返回字段: resumeSessionId / cliTool / runtimeKind / lastPrompt / launchedAt
2. 找匹配的 entry,记下 resumeSessionId / cliTool / runtimeKind
3. mcp__ccpanes__launch_task(
     projectPath: ...,
     resumeId: <resumeSessionId>,
     cliTool: <cliTool>,
     runtimeKind: <runtimeKind>
   )
   # prompt 必须为空 — 与 resumeId 互斥
```

或者用更通用的 `list_resume_sessions(cliTool, projectPath?)` 直接查 CLI 的 sessions 目录。

### D. Leader/Worker 编排（异步派 worker）

```
1. 读 CC_PANES_PTY_SESSION_ID 环境变量 → <leaderSessionId>
2. mcp__ccpanes__register_plan_leader(
     planPath, projectPath, cliTool="claude",
     sessionId: <leaderSessionId>,
     title: "..."
   ) → <leaderId>

3. mcp__ccpanes__launch_task(...) → <workerSessionId>

4. mcp__ccpanes__register_plan_worker(
     leaderId: <leaderId>,
     sessionId: <workerSessionId>,
     projectPath, cliTool="codex"
   ) → <workerId>

5. 把 <workerId> 写进 worker 的 prompt,要求它完成时:
   先 update_task_binding(id=workerId, status="completed", ...)
   后 report_to_leader(workerId, status, summary)

6. Leader 等 PTY [worker-report] 行;超时用 reconcile_plan_collaboration(leaderId) 兜底
```

**关键 gotcha**：`report_to_leader` 在 leader busy 时返回 `{sent: false, skipReason: "leader busy"}` 且**不重试不排队**。所以 worker 必须配合 `update_task_binding` 持久化状态。多 worker 并发时这条特别重要。

### E. 卡住 / 终止 / 重发

```
mcp__ccpanes__get_session_status(...)    # 看 lastOutputAt 是否还在动
mcp__ccpanes__get_session_output(..., lines=300)  # 抓尾部判断
mcp__ccpanes__write_to_session(..., text="\x03")  # 软中断
mcp__ccpanes__kill_session(...)          # 硬终止
# 然后重新 launch_task 或换 resumeId 续接
```

---

## REST API Fallback

如果 MCP 工具不可用（极少见），可走 REST API：

- **当前实现**：`cc-panes-api` crate 是 **placeholder**（`cc-panes-api/src/lib.rs:6`），真正 REST 仍挂在 `src-tauri/src/services/orchestrator_service.rs:686` 起的 Axum 路由
- **连接信息**：环境变量 `CC_PANES_API_BASE_URL`（如 `http://127.0.0.1:62674`） + `CC_PANES_API_TOKEN`

```bash
# 已知路由（不完全列表）
GET  /api/projects
POST /api/launch-task
GET  /api/task-status/{task_id}
GET  /api/sessions
GET  /api/session-status/{session_id}
POST /api/submit-to-session
POST /api/kill-session
```

```bash
curl -s -H "Authorization: Bearer $CC_PANES_API_TOKEN" \
  $CC_PANES_API_BASE_URL/api/projects

curl -s -X POST \
  -H "Authorization: Bearer $CC_PANES_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"projectPath": "/path/to/project", "prompt": "任务描述"}' \
  $CC_PANES_API_BASE_URL/api/launch-task
```

REST 是**应急通道**，优先用 MCP。

---

## WSL 路径处理（与 launch_task 配合）

- **`launch_task.projectPath`**：用 `list_projects` 返回的**原样字符串**（UNC `\\wsl.localhost\Ubuntu\...` 或 `/mnt/...` 都可能登记）。**别自己拼**。
- **`launch_task.prompt` 里的文件路径**：按 `/mnt/<drive>/...` 转，盘符小写，空格/中文用代码块/独立行包，避免被 shell 解释。
- **`runtimeKind`**：UNC/WSL 项目路径会自动推断为 `wsl`，但**显式写**更稳，文档少歧义。

详细转换表参考 `/ccbook:plan2codexwsl` 或 `/ccbook:plantocodex` skill 的"WSL 路径转换"段。

---

## 与全局 `ccpanes:launch-task` skill 的差异

| 维度 | 全局 `ccpanes:launch-task` | 本 `/ccbook:launch-task` |
|------|---------------------------|--------------------------|
| 受众 | 任何 cc-panes 用户 | cc-book 项目维护者 / 高级用户 |
| 内容 | 基础启动 + cliTool 选择 | + WSL / resume / PTY 交互 / leader-worker / REST fallback / 排障 |
| 用法 | "在某个项目启动" | "恢复昨天那个" / "PTY 卡住" / "派 worker 等异步反馈" |

简单启动场景两者都触发，**优先全局**（更轻量）。本 skill 适合：

- 解释为什么 launch_task 没生效
- 设计 leader/worker 编排
- 排查 PTY 反馈丢失
- 写自动化脚本调 REST

---

## 反模式

- ❌ 用 `get_task_status` 轮询 worker 完成 → 它只看启动事件，看不到 worker 中途状态
- ❌ 启动后只查 `get_session_status` 不读 `get_session_output` → 不知道 prompt 是否真注入
- ❌ `launch_task.projectPath` 自己拼 `/mnt/...` → 不匹配 `list_projects` 登记的 UNC 路径，启动失败
- ❌ resume 时同时传 `prompt` 和 `resumeId` → 两者互斥，会被拒
- ❌ 让 worker 只 `report_to_leader` 不 `update_task_binding` → leader busy 时反馈静默丢失
- ❌ 复用窗口用 `write_to_session` 发整段 prompt → 不会自动回车，prompt 卡在输入框；要用 `submit_to_session`
- ❌ 用 `update_todo({completed: true})` → 字段不存在，要用 `status` 字段
- ❌ 把 `create_todo({todoType: "spec"})` 当 Spec 创建入口 → MCP 没此参数，只会创建普通 Todo（见 [`/ccbook:spec`](spec.md)）

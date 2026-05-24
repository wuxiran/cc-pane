---
name: ccpanes-clean-launch
description: Cleanly launch a project's dev / build process in {{app_name}}-managed workspaces. Use when the user says "启动前端"、"跑后端"、"重启 dev server"、"start the api server"、"restart the worker"、"run the build"、"开服务"、"再启动一次"。Handles port/PID conflicts via MCP+skill loop, remembers last launch (command, cwd, runtime, env) so the next run is one-step. Supports local / WSL / SSH runtimes.
---

# 启动干净（Clean Launch）

参数: $ARGUMENTS

## 用途

让用户启动他们项目里的 dev server / 后端服务 / 编译进程时**不被旧 PID 和端口冲突拖累**——并且把"上次怎么启动的"记下来，下次一句话就能复现。

与 `launch-task` 的区别：
- `launch-task` 启动 **Claude / Codex CLI 本身**
- `clean-launch` 启动 **项目代码**（npm / cargo / mvn / sh 脚本 / docker / …）

## SOP

### 步骤 1 — 解析意图，定位 RunnerProfile

1. 从 `$ARGUMENTS` 提取项目路径和 profile 名（如 `clean-launch frontend in /path/to/proj`）。
2. 未指定 → 调 `{{mcp_server_name}}.list_projects` 让用户选项目。
3. 调 `{{mcp_server_name}}.list_runner_profiles(projectPath)`：
   - **空列表** → 引导用户给一条启动命令，调 `upsert_runner_profile` 创建。必填字段：`projectPath` / `name` / `command` / `cwd` / `runtimeKind`（local/wsl/ssh）。可选：`expectedPorts`（强烈推荐填，启动预演靠它）、`wslDistro`、`env`、`toolHint`。
   - **多个** → 按 `lastStartedAt` 倒序展示，默认推荐用户最近用过的；用户没指明就直接用第一个。

### 步骤 2 — 冲突处理语义

不要单独调用 `plan_runner_launch`。`start_runner` 会在内部完成启动预演；当返回 `status: "blocked"` 时，会携带完整 `RunnerLaunchPlan`：

```
{
  "profileId": "...",
  "profileName": "frontend dev",
  "conflicts": [
    { "port": 5173, "pid": 12345, "protocol": "tcp",
      "owningInstanceId": "...", "owningProfileName": "frontend dev" }
  ],
  "suggestedActions": ["killSelfThenStart" | "askUserBeforeKill" | "investigateUnknown" | "startDirect"]
}
```

收到 blocked 后，按 `suggestedActions[0]` 决策：

- **`killSelfThenStart`** → 冲突 PID 是同一 profile 上次的残留。**告知用户后**调 `kill_runner_pid(pid)` 清掉，再重试 `start_runner`。
- **`askUserBeforeKill`** → 冲突 PID 来自其他 profile / 已知 instance。向用户摘要"端口 X 被 profile 'Y' (PID Z) 占用"，问"kill 它，还是换端口启动 / 中止？"。按用户答复执行。
- **`investigateUnknown`** → 冲突 PID 不在 ccpane 登记里（陌生进程）。**不要**自动 kill。摘要进程信息给用户，建议：(a) 用户手动确认后再调 `kill_runner_pid`；(b) 修改 profile 的 `expectedPorts` 换端口；(c) 中止启动。

### 步骤 3 — 启动

直接调 `{{mcp_server_name}}.start_runner(profileId)`，根据 status 字段判断:

- **`status: "reused"`** → 已有 running instance(`instanceId`/`sessionId` 是上次的)。
  告知用户"已在跑，复用"，不重启。
- **`status: "blocked"`** → 端口被占，`launchPlan.conflicts` 给出占用方，
  `launchPlan.suggestedActions[0]` 给出建议:
  - `killSelfThenStart` → `kill_runner_pid(pid)` 后重试 `start_runner`
  - `askUserBeforeKill` → 询问用户后再决策
  - `investigateUnknown` → **不要**自动 kill，摘要进程信息让用户拍板
- **`status: "launched"`** → 启动成功，进入步骤 4 用 `sessionId` 查 ready。

### 步骤 4 — 等待 ready

调 `get_session_output(sessionId, lines=200)`，循环（最多 30s）查找 ready 特征行：
- npm/vite: `"ready in"` / `"Local:"` / `"localhost:"`
- cargo: `"Listening on"` / `"Server started"`
- maven spring-boot: `"Started ... in ... seconds"` / `"Tomcat started"`
- 自定义 sh 脚本：profile 可在 `metadata.readyPattern` 里指定（未实现时按通用关键字猜）

### 步骤 5 — 回报与记忆

回报给用户：
- ✅ 启动成功 / ❌ 失败原因
- 监听端口列表（调 `list_active_runners(projectPath)` 拿到 instance，端口由后端 `refresh_port_claims` 异步刷新）
- instance_id（便于后续 `stop_runner` 或再次 `clean-launch` 复用 profile）
- 提示："下次直接 `/clean-launch {{profile name}}` 一步完成"

## 常见对话样例

```
用户: 帮我跑一下前端
1. list_projects → 当前激活的项目 D:\proj
2. list_runner_profiles("D:\proj") → 找到 "frontend dev" (last_started 3小时前) + "backend api"
3. 选 "frontend dev"，start_runner → status="blocked"，launchPlan.conflicts=[5173 by PID 12345 owned by self profile]
4. → launchPlan.suggestedActions=["killSelfThenStart"] → "上次的 vite 没退干净，我先 kill 12345 再启动？"
5. 用户: 嗯
6. kill_runner_pid(12345) → killed=true
7. start_runner → status="launched"，sessionId
8. get_session_output 等到 "VITE ... ready in 432 ms"
9. ✅ 完成。监听 :5173 (PID 67890, instance i-xxx)
```

## 注意

- **不要绕过 start_runner 直接 launch**：会丢冲突检测、复用判断和 runner instance 登记。
- **WSL 项目**：runtimeKind="wsl"，需指定 `wslDistro`。端口在 Windows 和 WSL 两边各登记一次（hook 配合）。
- **SSH 项目**：本期只持久化 profile 元信息，远端端口跟踪不开启——`plan_runner_launch` 对 SSH profile 返回 `conflicts=[]` 后直接 startDirect。
- **profile 没填 expectedPorts**：`plan_runner_launch` 返回 conflicts=[] + startDirect，跳过冲突检测。鼓励用户回填 expectedPorts 让下次更智能。

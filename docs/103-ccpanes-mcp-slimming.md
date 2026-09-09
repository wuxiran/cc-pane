# 103 — ccpanes MCP 精简：core 常驻 + 管理台走 ctl

目标：把每个 CLI 会话常驻的 ccpanes MCP 工具表从 ~15k token 压到 ~6k（第二阶段 ~4k），不牺牲编排能力。
参考 Orca（stablyai/orca）的做法：agent 通过 CLI + 按需加载的 skill 操作宿主，MCP 只留必须的。

本文原是执行规格，**第一阶段已落地**。已定取舍仍在最后一节。

## 0. 实施记录（2026-09-05）

| 面 | 工具数 | compact JSON | ≈token（字节/4） | ≈token（字节/3） |
|---|---|---|---|---|
| `/mcp` core | 48 | 27.1k | 6.8k | 9.0k |
| `/mcp-full` 全量 | 102 | 56.4k | 14.1k | 18.8k |

改前同一份全量挂在 `/mcp` 上，每个会话都付。现在会话只付 core。`cc-panes-ctl --json tools` 的 raw 体积含空白，复量用 compact。

路径是 `/mcp-full` 而不是规格草稿里的 `/mcp/full`：Axum `nest_service("/mcp", …)` 会把 `/mcp/full` 吞进 core 通配。ctl `tools` / `call` 走全量，`mcp-proxy` 代理会话时仍走 core。

实施时相对 §3 的偏差：

- **`dispatch_task` 留在 core**，`launch_task` 只在 full。`dispatch_task` 是带 TaskBinding 的持久化超集，会话里派工本来就该走它；合并进 `launch_task` 会让所有现有 skill / prompt 一起改名，收益只是少一个别名。
- `get_task_dispatch` → `get_task_status(includeDispatch)`，`list_claude_sessions` → `list_resume_sessions(cliTool)`，`register_plan_child` 删除。旧名只留在 full 做兼容。
- Codex 本地 / WSL 启动加 `-c mcp_servers.ccpanes.enabled_tools=[…CORE_MCP_TOOLS…]`。清单定义在 `cc-cli-adapters::CORE_MCP_TOOLS`，与 `/mcp` 过滤共用。
- 两条 skill：`ccpanes-mcp-guide`、`ccpanes-admin`，默认选中。现有管理类 skill 和 concierge prompt 改走 ctl。
- 返回值：`get_session_output` 默认尾部 50 行去 ANSI；`list_*` / plan 协作默认精简，`verbose` 才给全字段。

按 ASCII schema 常用的字节/4，core 约 6.8k，贴着规格的 6.5k。按更保守的字节/3 是 9.0k，多出来的主要是 `dispatch_task` / task_binding / plan / memory 字段。第二阶段再收 action 枚举。

## 1. 改前现状

`src-tauri/src/services/orchestrator_service.rs` 一个 `#[tool_router]`，**102 个工具**，源码估算 ~15k token，实测 `tools/list` ~20.3k。每轮请求都在上下文里。

按组：会话/派发 2.9k · task_binding/todo 2.0k · launch_profile/runtime_config 1.7k · plan 1.6k ·
工作空间/项目 1.2k · shared MCP 配置 1.0k · ai_panel 0.9k · memory 0.8k · runner 0.7k · browser 0.6k · media 0.4k · files 0.2k。
单个最贵：`create_runtime_config` 1.1k（41 字段）、`dispatch_task` 0.95k（和 `launch_task` 重复 19 字段）、`cursor_bridge` 0.6k。

## 2. 目标结构

```
/mcp        → ccpanes（core）     注入给每个 CLI 会话。会话读写、派发编排、plan 登记、memory、通知、ai_panel、只读查询
/mcp-full   → 全量工具            不注入任何 CLI；只给 cc-panes-ctl `call` / `tools` 和外部客户端
```

管理台操作（工作空间 / 启动档 / shared MCP / runner / media / browser / files / cursor_bridge）**不再是会话里的 MCP 工具**，
agent 通过 shell 敲 `cc-panes-ctl call <tool> --json '{…}'`，用法写在一条按需加载的 skill 里。

**没有权限分层。** 所有会话拿同一份 core；所有会话都能敲 ctl。leader / worker 只是 TaskBinding 里的关系，不影响能调什么。

## 3. core 工具清单（保留 schema）

| 组 | 工具 | 说明 |
|---|---|---|
| 启动 | `dispatch_task` | 带 TaskBinding 的持久化派发（`parentBindingId` / `parentSessionId`）。`launch_task` 只留 full |
| 会话 | `list_sessions` `get_session_status` `get_session_output` `wait_for_session` `submit_to_session` `write_to_session` `kill_session` `list_panes` | |
| 编排 | `create_task_binding` `update_task_binding` `query_task_bindings` `get_task_status` `find_task_binding_by_session` `delete_task_binding` `report_to_leader` `send_to_worker` | `get_task_dispatch` 并入 `get_task_status`（加 `includeDispatch`） |
| todo | `create_todo` `update_todo` `query_todos` | |
| plan | `register_plan_leader` `register_plan_worker` `reconcile_plan_collaboration` `get_plan_collaboration` `list_recent_plans` `search_plans` `set_plan_archived` | `register_plan_child` 旧别名删除 |
| memory | `memory_add` `memory_search` `memory_get` `memory_update` `memory_delete` `memory_stats` | |
| 通知 / 面板 | `trigger_notification` `ccchan_say` `open_ai_panel` `update_ai_panel` `close_ai_panel` `claim_ai_panel` `get_ai_panel_events` `list_ai_panel_history` | |
| 发现 | `list_resume_sessions` `list_launch_history` `list_skills` | `list_claude_sessions` 并入 `list_resume_sessions(cliTool)` |
| 只读管理 | `list_workspaces` `get_workspace` `list_projects` `list_launch_profiles` | worker 看一眼不用走 ctl |

落地 48 个（含 `ccchan_say` 与只读查询）。其余只在 `/mcp-full`，通过 ctl 调。

## 4. 描述瘦身规则

工具 description 只回答"做什么、什么时候用"，**一到两句**。以下内容全部搬到 skill 正文（§6），schema 里不留：

- `launch_task.placement` 三种模式的长段说明 → 一句"beside / tab / silent，默认 beside，见 ccpanes-mcp-guide"
- `wait_for_session` 的状态枚举全列表、`write_to_session` 的 `\u` 转义规则、`create_todo` 的 `todoType` 约定、`trigger_notification` 的 `requiresInput` 语义
- 所有"通过 list_xxx 获取"的交叉引用

字段级：删 `alias`（`runtime` / `environment` / `parentTaskId`），`schemars(skip)` 的内部字段保持不出现。

预期：core 从 ~9.3k（直接切出来）→ ~6.5k。

## 5. 返回值瘦身（同样重要）

schema 是每轮固定成本，返回值是累计成本，长任务里往往更大：

- `get_session_output` 默认尾部 50 行、去 ANSI；`lines` / `raw` 显式要才给全
- `list_*` / `query_*` 默认精简字段（id、名字、状态、时间），`verbose: true` 才给全字段
- `launch_task` 响应只回 sessionId / bindingId / paneId / 一行状态，完整 `dispatchEnvelope` 只在 `verbose`

## 6. skill：`ccpanes-mcp-guide` + `ccpanes-admin`

放进 `src-tauri/resources/claude-bundle/default-skills/`，走既有 manifest（`descriptions` 双语）。

- `ccpanes-mcp-guide`：§4 搬出来的使用说明；触发词是编排类动作。
- `ccpanes-admin`：怎么用 ctl 管 CC-Panes。**不手写每个工具的参数**——正文教两步：
  1. `cc-panes-ctl tools --json --name <tool>` 看 schema
  2. `cc-panes-ctl call <tool> --json '<args>'`
  再列一张"想做什么 → 调哪个工具"的短表（工作空间增删改、启动档、shared MCP 起停、runner、media、browser、files、cursor_bridge）。

ctl 的连接信息从会话 env（`CC_PANES_API_PORT` / `CC_PANES_API_TOKEN` / `CC_PANES_API_BASE_URL`）取，`discovery.rs` 已有；`call` / `tools` 改指 `/mcp-full`。
现有 skill 里直接 `{{mcp_server_name}}.xxx` 调管理工具的（`workspace`、`organize-workspace`、`workspace-migrate`、`cursor-handoff`、`cleanup-processes` 若用 runner），改成 ctl 写法。

## 7. 改动清单（按顺序，每步可独立发）

0. **Codex 白名单** ✅：本地 / WSL 注入 `-c mcp_servers.ccpanes.enabled_tools=[…CORE_MCP_TOOLS…]`。
1. **量基线** ✅：全量 102 / compact 56.4k（≈14–19k token）。
2. **两个 router** ✅：core 挂 `/mcp`，全量挂 `/mcp-full`。CLI 注入仍是 `/mcp`，ctl `call` / `tools` 走 `/mcp-full`。
3. **合并 / 删除** ✅（见 §0）：`dispatch_task` 留 core；`launch_task` / 旧别名只在 full。
4. **描述瘦身** ✅ + `ccpanes-mcp-guide` skill。
5. **`ccpanes-admin` skill** ✅ + 管理类内置 skill / concierge 改 ctl。两条都进默认选中。
6. **返回值瘦身** ✅。
7. **复量** ✅：core 48 / compact 27.1k（≈6.8k token @ 字节/4，见 §0）。

第二阶段（量完再决定）：同族工具收成 action 枚举（`tasks(action)` / `plan(action)` / `memory(action)` / `ai_panel(action)`，参考 `cursor_bridge`），core → ~4k。

## 8. 风险

- **WSL 里的 ctl**：会话在 WSL 时 `cc-panes-ctl` 得能跑。走 Windows interop 调 `/mnt/.../cc-panes-ctl.exe` 最省事；interop 关了就需要 Linux 构建。步骤 5 前先在 WSL 里验证一次。
- **非 YOLO 会话**：ctl 每次是一条 Bash，会弹权限确认。管理台操作低频，可接受；这也是 core 不 ctl 化的原因。
- **两家都有延迟加载，但都不一定在生效**：Claude Code 新版有 tool search；Codex CLI 0.142.2+ 默认对 MCP 工具走 tool search（Responses API `defer_loading`，需 GPT-5.4+），
  但据现有资料只在 MCP 描述超过上下文窗口 **10%** 时触发——ccpanes 现在 ~15k / 200k ≈ 7.5%，很可能没触发，全量在上下文里。
  推论：精简的收益现在是真的；但"拆到 6.5k"和"延迟加载"是替代关系不叠加，越小越不触发。以 `/context` 和 `codex mcp list` 实测为准。
- **Codex 不响应 `tools/list_changed`**（0.145 仍只记日志，见 openai/codex#37417）。本方案没有运行中改工具表的环节，不受影响；以后若要加，Codex 只能重开会话。
- **外部客户端**：用户手配到 Cursor / 自己 Claude 里的 `/mcp` 只剩 core；要全量改配 `/mcp-full`。共享 MCP 页的本机卡片同时给出两条 URL。

## 9. 已定取舍（不再讨论）

- 不做权限分层，不做 admin 服务器，不做 `enable_admin` / 升级 / grant / 审批 UI。leader == worker。
- 管理台走 ctl + skill，不走 MCP。
- `launchOrigin` 字段不在本轮范围（无权限层就没有用途；审计需要时再加）。
- 记忆、启动档、工作空间层的注入优先级见 docs/98 与后续 docs/104（未写）。

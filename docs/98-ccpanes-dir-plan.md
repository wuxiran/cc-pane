# 98 — `.ccpanes` 目录职责规划（workspace-first 第二批的前置）

> 状态：**已评审通过（2026-09-02）**：① `<project>/.ccpanes/` 默认可提交，只忽略 `.cache/`；② 本地历史留在仓库 `.ccpanes/.cache/history/`，不搬去数据目录；③ MCP 改为工作空间层 + 启动注入，接受「不经 CC-Panes 直接跑 CLI 看不到工作空间 MCP」这个代价。本文只定规则与去向；每一批落地时按此对照。

## 为什么要先定这个

0.12.10 把 skill 改成 workspace-first 后，剩下 MCP / 快捷命令 / Automations / Cursor Bridge 也要跟进。
每一项都涉及「这份配置放哪」。不先把三个存储位置的职责划清，就会继续出现今天这种局面：

- 仓库里的 `<project>/.ccpanes/` 混放了**团队意图**（specs、workflow、快捷命令）和**机器缓存**（history 几百 MB、media、hooks 状态），
  又被模板 `.gitignore` 整目录忽略——想共享的没共享出去，不该进仓库的全在仓库里。
- 数据目录 `~/.cc-panes/` 下多出一个 `.ccpanes/history + plans`：默认工作空间的 path 就是数据目录，被当项目跑了本地历史。
- `~/.cc-panes/workspaces/<name>/` 里嵌了一个空的 `.ccpanes/`，只为放迁移用的 `projects.csv`。

## 三个位置，三条规则

| 位置 | 归属 | 规则 | 进 git？ |
|------|------|------|---------|
| `~/.cc-panes/` | 这台机器上的这个用户 | 应用配置、DB、Provider、启动档、shared MCP、用户 skill、内置 skill、会话/运行时 | 永不 |
| `~/.cc-panes/workspaces/<name>/` | 一个工作空间 | **默认层**。凡是「这一组项目共用」的配置都先放这里；按会话注入 CLI，不落到项目 | 永不 |
| `<project>/.ccpanes/` | 一个仓库 | **只放描述这个仓库本身、且值得随代码提交给团队的东西**。机器缓存与运行状态不得出现在这里 | **应该进**（这是它存在的唯一理由） |

判据一句话：**放进 `<project>/.ccpanes/` 之前先问「换台机器、换个人 clone 下来，这个文件还有意义吗？」——没有就不该在这。**

推论：
1. 项目层不再是兜底。找不到更好位置的东西默认去工作空间层，不是仓库。
2. `<project>/.ccpanes/` 反过来要**从 `.gitignore` 里拿掉**，改成目录内自带 `.ccpanes/.gitignore` 只忽略 `.cache/`。
3. CLI 主目录（`~/.claude` 等）继续零写入；项目目录只保留 CLI 机制强制要求的 hooks 配置。

## 逐项去向

### 现在在 `<project>/.ccpanes/` 的

| 内容 | 判定 | 去向 |
|------|------|------|
| `specs/`（Spec + Todo） | 仓库意图 | **留**，提交 |
| `workflow.md` | 仓库意图 | **留**，提交 |
| `quick-commands.json` | 仓库意图，但多数是工作空间共用 | **留**作项目覆盖层；新增工作空间层为默认（见下） |
| `prompts/`（长任务 prompt 落盘） | 派工中间产物，跟项目走但无共享价值 | 移到 `.ccpanes/.cache/prompts/` |
| `plans/`（plan-as-memory 归档） | 有回看价值，但按项目切不合理（plan 常跨项目） | 归到工作空间 `plans/`；项目层保留只读兼容读取，不再新写 |
| `journal/` | 会话日志，机器产物 | `.ccpanes/.cache/journal/` |
| `history/`（本地历史 DB + blobs） | 机器缓存，体积最大 | **原地不动，但归入 `.cache/`**：`.ccpanes/.cache/history/`。迁移只做一次 rename + 兼容读取旧路径 |
| `media/` | 生成产物 | `.ccpanes/.cache/media/` |
| `config.toml`（本地历史设置） | 设置，跟仓库走可接受 | **留**在 `.ccpanes/config.toml`，可提交（团队共享 ignore 规则） |
| `cli-hooks.json` | hooks 同步状态 | `.ccpanes/.cache/cli-hooks.json` |
| `session-state.json` | legacy，早已非权威 | 删除写入路径（保留读取兼容一个版本） |
| `handoff-latest.md` | 单次交接产物 | `.ccpanes/.cache/handoff-latest.md` |
| `projects.csv`（工作空间根目录的项目清单） | 写在**用户的工作空间根文件夹**（不是我们数据目录），与同处的 `CLAUDE.md` 配套，是给 agent 看的工作空间意图 | **留**。之前误判成数据目录内的东西；真正无用的是 `create_workspace` 在 `~/.cc-panes/workspaces/<name>/` 里顺手建的空 `.ccpanes/`，第一批已去掉 |

### 现在还不是 workspace-first 的（本规划直接指定落点）

| 项 | 现状 | 目标 |
|----|------|------|
| MCP 配置 | 项目级 `.claude/settings.local.json` + 全局 shared MCP | 工作空间 `mcp.json`：一组 server 定义 + 启用集。启动时**注入**（Claude `--mcp-config`、Codex `-c mcp_servers`），**不再写项目的 `.claude/settings.local.json`**。项目层保留可选覆盖（`.ccpanes/mcp.json`，可提交） |
| 快捷命令 | 全局 + 项目 | 工作空间 `quick-commands.json` 为默认层；解析顺序 项目 → 工作空间 → 全局 |
| Automations | 全局，只记 `cwd` | 定义加 `workspaceName`，存 `~/.cc-panes/workspaces/<name>/automations/`；UI 在工作空间下选项目 |
| Cursor Bridge `init` | 全局单一 `projectPath` | 登记簿改 `~/.cc-panes/workspaces/<name>/cursor-bridge/`，`init` 绑工作空间，项目按调用方所在项目取 |
| Memory | 已有 workspace scope | 不动，只补 UI 入口 |
| 状态上报 hooks | 项目 `.claude/settings.local.json` / `.codex/hooks.json` | **不动**——CLI 机制要求在项目目录；这是唯一允许留在项目目录的非 `.ccpanes` 写入 |

### 数据目录污染

- 默认工作空间不得把 `data_dir` 当项目：`workspace.path == data_dir` 时禁用本地历史与 plan 归档，并一次性清理已生成的 `~/.cc-panes/.ccpanes/`（只删我们能证明是自己写的：`history.db` 与 `plans/*.md`）。

## 目标布局

```text
~/.cc-panes/                          # 机器 · 用户
  config.toml  data.db  memory.db  providers.json  launch-profiles.json  shared-mcp.json
  skills/{builtin,user}/  sessions/  runtime/  mcp/  …
  workspaces/<name>/                  # 工作空间（默认层）
    workspace.json
    skills/            (.claude-plugin + skills/<n>/SKILL.md)   ← 0.12.10 已落地
    mcp.json           ← 第二批
    quick-commands.json← 第二批
    automations/       ← 第二批
    cursor-bridge/     ← 第二批
    plans/             ← 第三批（从项目层归拢）
    snapshots/

<workspace 根文件夹>/               # 用户自己选的工作空间根（可能不是 git 仓库）
  CLAUDE.md  .ccpanes/projects.csv  # 给 agent 看的项目清单，保持现状

<project>/.ccpanes/                   # 仓库 · 团队共享，随代码提交
  .gitignore           (内容：.cache/)      ← CC-Panes 自己写，首次创建目录时
  config.toml
  workflow.md
  specs/
  quick-commands.json  (可选覆盖)
  mcp.json             (可选覆盖)
  .cache/              # 机器本地，永不提交
    history/  media/  journal/  prompts/  cli-hooks.json  handoff-latest.md
```

## 分批

**第一批（已落地，0.12.10）**
1. ✅ `cc_panes_core::utils::project_dirs` 成为 `.ccpanes` 的唯一路径出口；首次创建目录时写 `.ccpanes/.gitignore`（`.cache/`），不覆盖用户改过的。本仓库自己的 `.gitignore` 从 `.ccpanes/` 改为 `.ccpanes/.cache/`。
2. ✅ 新写入全部走 `.cache/`：prompts（core codex 外置 + orchestrator 长 prompt）、journal、media、cli-hooks.json；`session-state.json` 停写（读侧保留一个版本兼容）。`handoff-latest.md` 由 skill 写，路径在 skill 文案里改（另一实例在改该文件，暂缓）。
3. ✅ `history/` → `.cache/history/`：`HistoryFileRepository::open` 首次打开时 rename 旧目录（`ensure_cache_entry`），只读打开与读侧统一走 `resolve_cache_entry` 双路径。
4. ✅ 数据目录污染：`HistoryService::set_protected_roots(data_dir)` 拒绝在数据目录内建库；`CC_PANES_WORKSPACE_PATH` 指向数据目录时不下发给 hook（plan 归档不再落 `~/.cc-panes/.ccpanes`）；启动时 `AppPaths::cleanup_self_ccpanes_pollution` 一次性删 `<data_dir>/.ccpanes/{history,plans,config.toml}`。
5. ✅ `create_workspace` / `ensure_default_workspace` 不再在 `~/.cc-panes/workspaces/<name>/` 里建空 `.ccpanes/`。用户工作空间根的 `projects.csv` 保持不动（见上表更正）。

**第二批（workspace-first 其余四项）**
6. ✅ 快捷命令工作空间层：`~/.cc-panes/workspaces/<name>/quick-commands.json`，`QuickCommandService::list/save_workspace`，tauri `list/save_workspace_quick_commands` + web `/api/quick-commands/workspace`；前端三层合并 global → workspace → project，按活跃 tab 的项目反推所属工作空间加载，新建默认落工作空间层。项目层创建目录改经 `project_dirs`（顺带写 `.gitignore` 守卫）。
7. ✅ Automations 归工作空间：`AutomationDef.workspaceName`（旧定义缺省 None，编辑时从 cwd 反推）；编辑器改为「所属工作空间 → 其下项目」两级选择，新建默认当前展开的工作空间及其首个项目；列表带工作空间徽章。**物理存储保持 `<data>/automations/` 单一目录**——调度器只需一处扫，按工作空间拆目录只增加复杂度不增加产品价值，与原表「存到 `workspaces/<name>/automations/`」的写法相比这是有意的简化。
8. ✅ Cursor Bridge 登记簿按工作空间：`CursorBridgeHub` 按工作空间名分发 `CursorBridgeService`（`~/.cc-panes/workspaces/<name>/cursor-bridge/`），`init` 绑工作空间（`workspaceName` 或由 `projectPath` 推出）并可设默认项目，六个 action 都接受 `workspaceName`/`projectPath` 覆盖；不带参数时工作空间与项目从调用方 launch 记录推断，所以 CC-Panes 内启动的 agent 不再需要 `init`。旧全局目录只读保留供 resume 回写搜索。解析顺序见 docs/96「作用域」。`handoff-latest.md` 路径同步改为 `.ccpanes/.cache/`（skill 文案）。
9. ✅ MCP 工作空间层 + 启动注入（按下节 plan 落地，偏差见「实施记录」）。

### MCP workspace-first plan

> **实施记录（0.12.10）**：目标 1–5 全部落地，6 做了一半。
> - `McpConfigService` 改为分层：`McpLayer::Workspace` → `~/.cc-panes/workspaces/<name>/mcp.json`，`McpLayer::Project` → `<repo>/.ccpanes/mcp.json`（经 `project_dirs::ensure_ccpanes_dir`，顺带写 `.gitignore` 守卫）。条目 `McpServerConfig` 保留 `command/args/env` 供 UI 编辑，其余字段（`type`/`url`/`headers`）经 `#[serde(flatten)] extra` 无损透传，HTTP 条目能进能出。`.claude/settings.local.json` **只读**：`list_legacy_project_servers` + `import_legacy_project_servers(into, overwrite)`。
> - 注入：`CliAdapterContext.workspace_mcp_servers`（Claude 原生 JSON 形状）。Claude 在用户全局之后、shared 之前合并；Codex 新增 `push_mcp_json_override` 展开 `command/args/env` 或 `url` 成 `-c mcp_servers.<name>.*`；同名 shared 优先、`ccpanes` 名字保留。`allowed_mcp_server_ids_for_profile` 多一个入参 `workspace_mcp_server_names`：Default 模式扣掉 `disabled_server_ids`，Custom 模式只放 `enabled_server_ids`；`CliAdapterContext::allowed_workspace_mcp_servers()` 统一过滤。**仅本机运行时注入**（SSH/WSL 不注入，同 skills 的理由：stdio 命令是给这台机器写的）。
> - 命令/路由：`list/get/upsert/remove_mcp_servers` 改为 `workspaceName | projectPath` 选层；新增 `list_legacy_mcp_servers`、`import_legacy_mcp_servers`；web `GET /api/mcp/legacy-servers`、`POST /api/mcp/legacy-servers/import`。orchestrator 的同名 MCP tool 现在写项目覆盖层。
> - UI：`ProjectMcpSection` 加 `workspaceName` 视图（工作空间右键 →「工作空间 MCP」，复用 `mcp-config` tab）；项目视图顶部对尚未导入的旧配置给一键导入，默认导入到项目所属工作空间，孤儿项目则导入到项目覆盖层。**未做**：设置 → 工具 里的独立「工作空间 MCP」节——右键入口够用，重复面板先不加。
> - 未做的一件：`.claude/settings.local.json` 里的 hooks 部分仍由 `sync_project_hooks` 管，与 MCP 无关，不在本批。

**现状**（已核实代码）：
- Claude 每次启动已经生成 `<data>/mcp-<session>.json` 并传 `--mcp-config`，内容 = 用户全局 `~/.claude.json` 的 mcpServers（低优先级）+ shared MCP（HTTP 代理）+ `ccpanes`（最高）。Codex 走 `-c mcp_servers.<key>.*` 逐项覆盖。**注入通道已经存在**。
- 项目级 MCP 是 `McpConfigService` 直接读写 `<repo>/.claude/settings.local.json` 的 `mcpServers`，由 Claude 原生读取；Codex/Cursor 看不到。这是目前唯一还在往项目目录写配置的路径（hooks 除外）。
- 启动档 `mcp_policy`（Default/Custom/Disabled，enabled/disabled ids，include_ccpanes/shared）在 `terminal_service` 里决定 `allowed_mcp_server_ids` 与 `disable_unlisted_mcp_servers`。

**目标**：
1. 新增 `~/.cc-panes/workspaces/<name>/mcp.json`：`{ "mcpServers": { name: {command,args,env} | {type:"http",url} } }`，与 Claude 原生格式同构，便于从 `settings.local.json` 一键导入。
2. `CliAdapterContext` 加 `workspace_mcp_servers: Map<String, Value>`；Claude `generate_mcp_config` 在「用户全局」之后、「shared」之前合并（工作空间覆盖用户全局同名）；Codex 展开为 `-c mcp_servers.*`；其他 CLI 不支持则忽略并在启动诊断里标注。
3. 项目层可选覆盖 `<repo>/.ccpanes/mcp.json`（可提交），同结构，在工作空间层之后合并。
4. `McpConfigService` 改为读写这两份文件；**停写 `.claude/settings.local.json` 的 mcpServers**（hooks 那部分继续由 `sync_project_hooks` 管）。`ProjectMcpSection` 改成「项目覆盖层」编辑器，并提供「从 .claude/settings.local.json 导入到工作空间」的一次性按钮；旧文件只读不删。
5. 启动档 `mcp_policy` 的 enabled/disabled ids 对三层统一按 server name 生效。
6. 设置 → 工具 → 新增「工作空间 MCP」节（列表 + 增删改 + 导入），工作空间右键加入口。

**代价（已确认接受）**：不经 CC-Panes 直接在项目里跑 `claude` 时看不到工作空间 MCP。

**验收**：启动 Claude 时生成的 `mcp-<session>.json` 含工作空间 server；Codex 参数含 `mcp_servers.<name>`；项目目录 `.claude/settings.local.json` 不再因 MCP 编辑而变化；旧项目的 mcpServers 能一键导入。

**第三批**
10. ✅ plans 归拢到工作空间层。写侧：启动时下发 `CC_PANES_PLANS_DIR=~/.cc-panes/workspaces/<name>/plans`（SSH 不下发；WSL 经 WSLENV `/p` 翻译），`cc-panes-cli-hook` 的 plan 归档候选顺序改为 `$CC_PANES_PLANS_DIR` → `<project>/.ccpanes/.cache/plans`（孤儿项目的机器本地兜底）；**不再写 `<project>/.ccpanes/plans/`**——那个位置在 `.ccpanes/` 改可提交后会把 plan 提交进仓库。读侧：`PlanService::new(app_paths, workspace_service)` 按项目所属工作空间聚合三层（工作空间 → 项目缓存 → 旧位置只读），`PlanEntry.layer` 标来源，同名以高层为准；plan 面板给旧位置条目一个「仓库内旧位置」角标。已有的 `.ccpanes/plans/` 不自动搬家（可能已被提交，搬了会出 diff），用户自行处理。

## 待你拍板的三个点

1. **`<project>/.ccpanes/` 改为默认可提交**（只忽略 `.cache/`）——这会让 specs / workflow / config.toml 第一次真正进团队仓库。已经有用户仓库把整个 `.ccpanes/` 忽略了，我们的模板改了不影响他们已有的 `.gitignore`，但新项目会开始提交这些文件。同意吗？
2. **本地历史留在仓库 `.ccpanes/.cache/history/`**（只改路径不搬家），还是搬到 `~/.cc-panes/projects/<hash>/history/`？我倾向前者：几百 MB 的 blob 搬家风险大，且历史跟仓库同生共死本来合理。
3. **MCP 那一批是否接受「不再写项目 `.claude/settings.local.json`」**——这意味着不经 CC-Panes 直接在项目里跑 `claude` 时看不到工作空间 MCP（hooks 同理但那是必需的）。这是 workspace-first 的必然代价，需要你确认。

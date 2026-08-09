# 89 · MCP 工具面收编（方向文档，未排期）

> 2026-08-09 讨论产物。背景课题：「MCP 是正确的路子吗？」——结论是分层的：
> 真正的资产是 orchestrator/daemon 的服务化底座（daemon + REST + WS），MCP 只是它的一张可替换门面
> （另两张：`cc-panes-ctl` CLI 门面、Tauri IPC）。MCP 挣得住位置的只有两点：
> **跨 CLI 可移植性**（Claude/Codex/opencode 都说 MCP）与 **per-session 身份注入**（`mcp-<sessionId>.json`
> 携带 launchId/token，串台事故反证了它的价值）。因此方向不是废 MCP，而是把工具面从 90 收到 ~25：
> 只留「必须宿主配合的任务动作」，管理长尾下沉 CLI/UI，用法教学交给 skills 而非 tool description。

**状态**：方向文档，未排期。实施前先做 §5 的调用频次统计，按「方向文档 vs 单项评审」纪律逐刀抽 plan。

## 1. 现状盘点（90 个 `#[tool]`）

统计口径：`src-tauri/src/services/orchestrator_service.rs` 中 `#[tool]` 标注的方法，2026-08-09 于 `dev/v0.12.3`（3ac97d2）数得 90 个。

| 域 | 数量 | 工具 |
|---|---|---|
| 会话原语 | 10 | write_to_session、submit_to_session、kill_session、get_session_status、wait_for_session、list_sessions、get_session_output、list_launch_history、list_resume_sessions、list_claude_sessions |
| MCP 服务器管理 | 12 | list/get/upsert/remove_mcp_server；shared 版 get_shared_mcp_config/get_shared_mcp_status/upsert/remove/start/stop/restart_shared_mcp_server、import_shared_mcp_from_claude |
| Runner | 10 | list/upsert/delete_runner_profile、plan_runner_launch、start_runner、stop_runner、kill_runner_pid、list_active_runners、list_workspace_port_reservations、list_port_conflicts |
| Plan 协作 | 10 | register_plan_leader/worker/child、report_to_leader、send_to_worker、get_plan_collaboration、reconcile_plan_collaboration、list_recent_plans、search_plans、set_plan_archived |
| Launch/Profile | 8 | launch_task、list_launch_profiles、create_runtime_config、delete_launch_profile、bind_workspace_launch_profile、list/set/clear_cli_launcher_override |
| Workspace/项目 | 7 | list_projects、list_workspaces、get_workspace、create_workspace、add_project_to_workspace、scan_directory、get_task_status |
| Memory | 6 | memory_search/add/get/update/delete/stats |
| AI Panel | 6 | open/update/close/claim_ai_panel、list_ai_panel_history、get_ai_panel_events |
| UI 打开类 | 6 | open_folder、open_file、open_browser_tab、close_file、list_open_files、list_panes |
| 浏览器自动化 | 4 | browser_navigate/evaluate/screenshot/click |
| Task Binding | 5 | create/update/delete_task_binding、find_task_binding_by_session、query_task_bindings |
| Todo | 3 | query_todos、create_todo、update_todo |
| 通知 | 2 | trigger_notification、ccchan_say |
| Skills | 2 | list_skills、list_external_skills |

**膨胀根因不是能力多，是两个惯性**：①每个 CRUD 动词各占一个工具；②「管理面」（配置这台机器）与「使用面」（完成当前任务）混在同一张工具面上。

## 2. 第一刀：CRUD 合并同类项（90 → ~55）

单工具 + `action` 枚举收编，能力无损：

| 家族 | 现在 | 收编后 |
|---|---|---|
| memory_* | 6 | 1（action: search/add/get/update/delete/stats；或读写拆 2） |
| ai_panel | 6 | 2（读 / 写分开，保留 claim 的 CAS 语义在写侧） |
| task_binding | 5 | 1 |
| todo | 3 | 1 |
| cli_launcher_override | 3 | 1 |
| runner_profile | 3 | 1 |
| mcp_server 管理 | 12 | 2（配置 CRUD 一个；shared 生命周期 start/stop/restart/status 一个） |
| plan 检索 | 3 | 1（list_recent/search/set_archived） |
| 会话历史三兄弟 | 3 | 1（`query_sessions` 带 source: launch_history/resume/claude） |

代价两条，实施时要认账：

- **权限粒度变粗**：没法在 MCP 客户端侧单独放行「只读不写」，需要 action 级白名单或在服务端做只读判定。
- **单工具 schema 变长**：合并后的 description 要写清 action 枚举，别把省下的 token 又吐回去。

## 3. 第二刀：管理面撤出 MCP（55 → ~25）

判据：**agent 在一个具体任务里永远不该主动做的事，不配占工具面。** 这批下沉到 `cc-panes-ctl`（agent 需要时走 bash）或 UI：

- MCP 服务器管理全部 12 个（含 import_shared_mcp_from_claude）
- runner_profile 增删改、cli_launcher_override 三件套
- create_runtime_config、bind_workspace_launch_profile、delete_launch_profile
- scan_directory、create_workspace（项目接入是人的动作，skill 引导走 ctl）

**browser_* 四件单独打问号**：agent 普遍自带浏览器能力（chromedev/playwright），CC-Panes 内嵌浏览器的自动化面疑似伪需求——不拍死，等 §5 的调用数据说话。

## 4. 目标核心面（~25 个）

launch_task；query_sessions；write/submit/kill_session；get_session_status、wait_for_session、get_session_output、list_sessions；list_panes；register_plan_leader/worker、report_to_leader、send_to_worker；get/reconcile_plan_collaboration；task_binding×1；todo×1；memory×2（search + write）；list_workspaces/list_projects；open_file/open_folder；trigger_notification；skills×1。

预期收益记对账：

- **Claude 侧上下文收益有限**——新版 Claude Code 已对 MCP 工具做 deferred 加载（ToolSearch 按需取 schema），痛感已缓解。
- **主要受益者是 Codex/opencode**（不做延迟加载，90 个 schema 全量入场）**和工具选择准确率**——选错率与候选数正相关，收窄本身是质量收益。
- tools/list 一屏可读，MCP Server Instructions 里的典型流程与工具面重新对齐。

## 5. 实施前置：用数据砍，不用直觉砍

先拿至少一周的 `tools/call` 日志按工具名统计调用频次（orchestrator 侧加个计数落盘即可，或直接 grep 现有日志）。预期长尾里约一半是零调用——零调用工具直接进第二刀；有调用但低频的，看调用方是 skill 引导还是模型自发，skill 引导的可以随 skill 改写一起迁到 ctl。

**隐私红线（埋点 ≠ 遥测）**：①只计数不记内容——统计粒度为「工具名 → 次数 + 最后调用时间」，不记参数/prompt/会话内容，敏感信息从头不存在；②数据不出机器——落本机 `data.db`（`usage_stats_service.rs` 同模式），统计模块零网络调用（开源可 grep 验证）；③对用户透明且反哺——计数做成用户可见（设置页/ctl 命令「你的 AI 最常用哪些工具」）；④作者取数只走两条腿：自家 dogfooding（本机数据足够支撑砍伐决策）+ 显式自愿导出（`ctl stats export` 聚合计数，用户确认后自行提交，同 cli-gh-access 崩溃上报模式）。**禁止任何自动上传链路。**

## 6. 迁移与兼容注意

- `register_plan_child` 等 leader/worker 链路工具被在途 skill（plantocodex/plantocc/planreview）引用，收编重命名必须同步改 skill 文案，否则旧 skill 指挥新工具面直接断链。
- 旧版实例/已发布安装包仍会按旧工具名调用——服务端保留旧名 alias 一个版本周期（薄转发到新工具），再删。
- `orchestrator_service.rs` 现已 1.4 万行，收编时顺手把 tool handler 按域拆文件，别在单文件上继续堆。
- 同场讨论的相邻结论（另两个课题，记录备查）：worktree 从「默认隔离」降级为特例（仅 fanout 同题多解 / 并行中途跑 build/test / 保住主树三场景）；fanout-compare 降级为「能力边界标定工具」，日常多视角需求收敛到「一份实现 + 一次交叉评审」（planreview 形态）。

## 7. ctl 与 MCP 的能力分界（草案，待精修）

回答「砍下来的 65 个工具去哪」+「两条通道要不要刻意错开」。原则：**功能共享同一底座（都是 REST/daemon 的门面），刻意让某能力"只此一家"是人为造墙；真正的区分轴是身份与故障域**，这两条是两个形态天然就不同的性质。现状里分化已经长出来了（ctl 的 `tools/call` 泛化透传使其今天就是 MCP 超集；daemon 直连原语在 0.11.2 事故中救过 5 条 worker），本节只是把它明确成规格。

三条区分轴：

1. **身份绑定的动作归 MCP**。MCP 调用经 `mcp-<sessionId>.json` 天生携带 per-session 身份，`report_to_leader`/`send_to_worker`/`register_plan_*` 不用自证「我是谁」。这类动作放 ctl 就得手工传 `--session-id`，而手工传身份正是串台事故的温床（agent 无法自察身份，见工作空间 docs/62）。判据：**动作语义里含「我」的留 MCP**；ctl 侧仅作救援，且必须显式传 id。
2. **跨故障域救援归 ctl，且必须是一等实现而非透传**。MCP 与 orchestrator 同生共死，ctl 的价值在 orchestrator 死后。会话原语在两边**故意重叠**——同一能力部署在两个故障域，不是重复建设。实施红线：ctl 救援路径不得借道 `tools/call`（那仍走 orchestrator），必须保持 daemon 直连的独立实现；规格化时别在「消除重复」的洁癖下合掉。
3. **管理面归 ctl 一等子命令，长尾靠透传兜底**。§3 砍下的工具两档处置：高频管理动作（profile 增删、mcp server 配置、scan_directory）升格为 ctl 正经子命令（`--help` 自描述、零常驻上下文成本——CLI 形态的比较优势）；其余长尾不写子命令，`tools/call` 泛化透传兜住。**MCP 收编不删除任何能力，只收窄「广告位」**：90 个 schema 常驻 → 25 个常驻 + 其余按需可达。

权限模型的天然不对称也参与分界：MCP 工具在 harness 里逐工具细粒度白名单，bash 跑 ctl 只能按命令模式粗放行。故「危险但任务中需要」的动作（kill_session）留 MCP 吃细粒度授权；「危险且本该人做」的动作（bindings 写、批量清理）留 ctl 并保持显式护栏（`--force-offline-db` 逃生阀是对的形态）。

一句话规格：**MCP = 任务进行时 + 身份绑定 + 细粒度授权的小面；ctl = 管理面 + 跨故障域救援 + 泛化超集；重叠区只有会话原语，且是故意的。**

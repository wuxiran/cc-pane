# 74 · 开发台账：编排面板的重定位

> 方向文档 + 分批 roadmap。按项目纪律，方向性文档不做整体预审；实施时逐批抽出独立 plan 再交叉评审。

## 症状

worktree 匿名淹没工作空间（docs/62：21 条项目 19 条 worktree、14 条死路径）、项目记录残留、todo/plan/会话痕迹散落无人回看——表面是四个问题，本质是同一件事：**AI 干活留下的痕迹没有统一账本**。用户面对一堆 `cc-book-wt-*` 目录时真正的问题不是"怎么少建"，而是"这个是干嘛的、完没完、敢不敢删"——现在系统里没有任何一个视图能回答。

现有编排面板（`web/components/orchestration/OrchestrationFullView.tsx`）是**运行时监控**：它回答"谁正在跑"，任务结束后那条记录就没人看了；没有"这件事收尾了吗"的概念，也没有 worktree/todo/plan 的关联展示。

## 定位：监控与台账是两种时态

- **监控（现在时）**：盯 5 个 worker 跑——要实时输出、状态徽章、busy 排队。现有面板做的就是这个，保留。
- **台账（过去时）**：上周那件事收尾了没——要用途、结论、待收尾标记、清理操作。目前完全缺失。

两种心智硬揉进一个列表会两头不讨好。方案：同一面板两模式——**进行中**（现有运行时视图原样）/ **台账**（按工作项组织）。worktree、todo、plan 是工作项下的切面，不做平行 tab。

与 docs/64 fleet 拓扑图的边界：台账化不捆绑图形化。fleet 是"监控"维度的野心（拓扑、轨迹、直方图），另行排期；本文档只做"台账"维度。

## 工作项模型：骨干 = task_binding

不新建 work_items 实体。一条 role=leader（或无 parent 的 task）的 binding 及其经 `parent_id` 归属的 workers = 一个工作项。理由：账本骨架在库里已经存在，binding 上挂着全部切面的锚点，且是天然的扩展位（以后新增切面继续往 `metadata` 长）。

现有字段盘点（`cc-panes-core/src/models/task_binding.rs:86-123`）：

| 台账问题 | 现有字段 |
|---|---|
| 这件事是干什么的 | `title`、`prompt`、`plan_path` |
| 谁在哪干 | `project_path`、`workspace_name`、`cli_tool`、`role`/`parent_id` |
| 干完了吗、结论是什么 | `status`、`progress`、`completion_summary`、`exit_code` |
| 扩展位 | `metadata`（JSON，`serde_json::Value`，零迁移） |

切面挂接方式：

| 切面 | 挂接 | 现状 |
|---|---|---|
| plan | `plans.task_binding_id` 反挂（db.rs:293-317）；plans 表已有 `intent`/`tags_json`/`risk`/`followups`/`archived`，语义可借用 | 已通 |
| worktree | 约定 `metadata.worktreePath` + `metadata.worktreeMainRepo`；register 链路的 metadata 透传已存在（`task_binding_service.rs:290/319/372/398`），缺的只是服务端自动检测 + 字段约定 | **批次 1 补** |
| todo | `todo_id` 列；回收待办用约定 `todoType="worktree"`、`scope=External`、`scopeRef=canonical_project_path(worktreePath)` | **批次 1 补** |
| spec | 经 todo 间接（`specs.todo_id`，db.rs:122） | 已通 |

### 漏账清单（接受的边界）

以下不入账，文档明确接受、不补链路：

1. **未经编排的散活**（用户直接开终端干的）——`launch_history` 每项目唯一索引只留最后一条（db.rs:702-703），历史无法回填；且散活本就没有"用途"元信息可记。
2. **ctl 离线写**（`--force-offline-db`）绕过服务层——逃生阀本就绕过不变式，台账弱关联（路径匹配）兜底可显示。
3. **`report_to_leader` 的补投队列**是内存态不落库（orchestrator_service.rs:10721-10906）——worker 的最终结论已落 `completion_summary`，中间汇报不入账；若将来要"汇报流水"，用现成的 `append_metadata_array_item`（task_binding_service.rs:172）往 metadata 数组追加即可，不动队列。

## 生命周期与数据耐久

状态机（前两段是现状，后两段是新增语义）：

```
进行中 (pending/running/waiting)
  → 已结束 (completed/failed)
    → 待收尾   ← 新：派生态，非落库状态
      → 已归档 ← 新：落库
```

- **待收尾**是派生判定不落库：`status ∈ {completed, failed}` 且（关联 worktree 目录仍存在 / 回收 todo 未 done / 分支未合并入 main——第三项 v1 不做，成本高且 squash-merge 工作流下 `git cherry` 判不准，见 docs/72）。
- **已归档**需要落库。binding 目前是"可删的运行时记录"（级联删除见 `task_binding_repo.rs:286-328`），台账要求账目耐久。方案：**加 `archived_at` 列**（对齐 specs 表既有做法，而非塞 metadata——归档要进 WHERE 过滤和索引，JSON 字段做不到）。清理入口的语义梳理：
  - UI 的"删除任务"→ 改为归档（默认视图隐藏，台账模式可见"含已归档"开关）；
  - 级联硬删保留给孤儿修复（`useOrphanSessionReconciler` 等对账链路）与用户在台账里的显式"彻底删除"；
  - `query_task_bindings` 默认过滤 `archived_at IS NULL`，加参数放开。

## 台账模式信息架构

组织维度：工作项列表（默认，按 `updated_at` 倒序）+ 「仅看待收尾」过滤 + 「按 worktree」视角（等价于原 worktree 台账设想：以 worktree 为行，含无 binding 关联的孤儿 worktree）。

行内信息：用途（title / prompt 摘要）、状态徽章、plan 链接、worktree（分支 + 路径三态，复用 `workspace_health.rs:53` 的 `classify_path(&str, is_ssh)`）、todo 状态、时间。

操作：查看详情（复用 `TaskDetailPanel`，跳转与通知同构：`setSelectedTaskId` + 切 tab）、打开终端、**收尾**（一键：`remove_worktree` → 联动删项目记录 → 关回收 todo → 归档 binding）、归档。

UI 约束：状态色映射与空态遵守 docs/46 风格宪法；**不轮询不监听**（docs/41 纪律），台账模式激活时拉一次 + 手动刷新；Zustand selector 只选稳定引用（CLAUDE.md gotcha）。

## 实施批次

每批可独立抽 plan、独立交叉评审、独立发版。

### 批次 1 · 强关联 + 回收 todo（纯后端，零迁移）

- `worktree_service.rs` 加只读 `linked_worktree_info(path)`：调 `list_worktrees`，要求自身是列表里一条**非 main 的 worktree 根**（防 monorepo 子目录误判，CLAUDE.md 既有守卫）。
- `task_binding_service.rs` 加 `with_worktree_detection(Arc<WorktreeService>)` 构造器；`register_plan_worker`(L336) / `register_plan_leader`(L269) 前置 enrichment：显式参数优先，否则检测 `project_path`，命中则往 metadata merge `worktreePath`/`worktreeMainRepo`（不覆盖已有键）。MCP 参数结构（orchestrator_service.rs:3144 附近）加可选 `worktreePath`。**服务端检测一处即同时覆盖 MCP 与 Launcher 两条写入路径**（Launcher 建 worktree 只替换启动路径，`LauncherDialog.tsx:152-171`，binding 是会话内 register 时才建）。
- 新 `WorktreeHygieneService`（cc-panes-core）：`ensure_worktree_todo`（查重键 = 身份键，幂等，失败只 warn 不阻断主操作，参照 `spec_service.rs:96-137`）/ `complete_worktree_todo`。钩在 Tauri `worktree_commands.rs` 的 add/remove、REST `routes/git.rs` 同两处、MCP `add_project_to_workspace`(orchestrator_service.rs:5378) 之后——**worktree_service 本体不动**（docs/62 纪律：Rust remove 只跑 git，编排在上层）。
- 验收：MCP 实测 register 后 `query_task_bindings` 见 metadata；建/删 worktree 后 `query_todos(todoType="worktree")` 一条待办出现/标 done；跨 `/mnt`↔盘符形态查重命中同一条。

### 批次 2 · 台账聚合读服务

- 新 `DevLedgerService`（cc-panes-core，四个依赖 Workspace/Worktree/TaskBinding/Todo 双端都持有，parity 免费）：工作项 join 切面、worktree 视角行、孤儿行（metadata 有 worktreePath 但 git 枚举没有）、三态、`needsCleanup` 派生。
- join 索引全部过 `canonical_project_path` 身份键；强关联（metadata.worktreePath）优先，`project_path` 路径匹配弱兜底；同路径多条取 `updated_at` 最新并记条数。
- 枚举纪律：跳过 SSH；WSL UNC 且 `!is_wsl_vm_running()` 直接跳过 git 枚举标 unverifiable（不唤醒 VM，docs/71）；并发上限 8、单仓失败 warn 跳过；Tauri 命令包 `spawn_blocking`，REST 对等路由。
- 验收：单测覆盖强弱关联优先级 / 孤儿行 / is_main 过滤；100+ 项目工作空间实测 < 2s。

### 批次 3 · 面板两模式重构

- `OrchestrationFullView.tsx`：`MainTab`(L34) 现为 `"tasks" | "notifications"`，重构为 模式（进行中/台账）× tab 的结构；台账列表组件 + 收尾操作链。
- 提取 `useProjectHygiene.ts:100-123` 的 `handleWorktreeRemoved` 核心为独立函数（只依赖 `useWorkspacesStore.getState()` + `projectPathsEquivalent`，可安全提取），sidebar 与台账共用；todo 关闭已由批次 1 的 Rust 钩子完成，前端不管 todo。
- 新 store `useDevLedgerStore`（不塞进 useOrchestratorStore；不订阅事件不轮询，in-flight 复用）。
- 验收：端到端走一遍"派活 → 完成 → 台账见待收尾 → 一键收尾 → 目录/记录/todo 三清"。

### 批次 4 · 归档语义落库

- `task_bindings` 加 `archived_at` 列（migration）；`query_task_bindings` 默认滤未归档；UI 删除改归档、台账加"彻底删除"与"含已归档"开关；对账链路保留硬删。
- 验收：归档后进行中视图消失、台账可见；孤儿对账不受影响。

## 风险

| 风险 | 对策 |
|---|---|
| 路径形态不一致（`/mnt` vs 盘符 vs WSL UNC）join/查重失败 | 一切索引键与 scopeRef 统一过 `canonical_project_path`；测试覆盖跨形态 |
| worktree 目录已删但 binding/todo 还在 | 孤儿行 + 三态；收尾操作对 missing 行降级为只清记录 |
| 同一 worktree 多次派活 | 取最新 binding + 条数角标 |
| 旧 daemon/安装版调用新接口 | 新参数全 Option + 服务端检测兜底；dev 下改 core 后须重建拷贝 daemon（CLAUDE.md gotcha） |
| 归档语义改动误伤对账/恢复链路 | 批次 4 单独做、单独评审；级联硬删保留给对账 |

**不做**：文件系统监听、常驻轮询、fleet 图形化（docs/64）、`launch_task` 注册门禁改动（那是 A 方案与后续 B/D 的范围）、work_items 新实体表。

## 关联

- docs/62：worktree 卫生的 UI 侧修复（分组/三态/清理对话框/删除联动）——本文档的收尾操作链复用其成果。
- A 方案（skill 改默认，worktree 显式 opt-in）：独立执行，收窄产生源头；本文档管住已产生的存量与合法使用场景，两者互补。
- docs/64：fleet 拓扑视图，监控维度，另行排期。

## 遗留

- "分支未合并入 main"的待收尾判定 v1 不做（squash-merge 下 `git cherry` 判不准，docs/72）。
- 散活（未经编排）不入账，是否补链路视台账实际使用情况再议。
- worker 汇报流水入账（metadata 数组）留待有真实需求再开。

# 114 · 多阶段持久工作流 + 结构化结果

> 状态：设计 + v1 实现（feat/staged-workflow）。与 docs/74（task_binding 是工作项骨干）、
> docs/90（派工模型）衔接。概念参考 t3code `apps/server/src/workflows`（幂等键、并发位、断点恢复），
> **不引入脚本引擎**：阶段是声明式数据，不是可执行脚本。

## 1. 要解决什么

现在 leader 派工全靠「人肉编排」：`dispatch_task` 发一个 worker → 等 `report_to_leader` 的
自由文本 → 读懂 → 再派下一批。问题有三：

1. **不持久**：编排逻辑活在 leader 的上下文里。leader 会话挂了、app 重启了，「下一步该干什么」随之丢失。
2. **结果不可机读**：worker 的结论是一段 `completion_summary` 文本，下一步要用（文件列表、
   PR 号、是否通过）只能让模型再读一遍、猜一遍。
3. **重复派发**：leader 重试或恢复时，同一件事可能被派出两个会话。

v1 的目标：**一个父 TaskBinding 声明一串有序阶段，系统负责按序派发、合流、等审批、断点续跑；
worker 可以交回经 schema 校验的 JSON 结果，后续阶段的 prompt 可以引用它。**

## 2. 与 docs/74、docs/90 的关系

- **骨干不变（docs/74）**：不新建「工作项」实体。工作流 = 一个父 TaskBinding（`workflow_id` 就是
  父 binding 的 id，一对一）；每个阶段派出的子任务就是普通的子 TaskBinding（`parent_id` = 父 binding），
  照常出现在台账 / 树视图 / `get_task_status` 里。新表只存「编排进度」，不复制任务数据。
- **派工模型（docs/90）**：工作流是 §1.1「契约冻结后扇形展开」和 §1.2「流水线化」的**载体**：
  典型三段式 = 契约阶段（1 个 worker，审批点）→ 实现阶段（≤4 个并行 worker，合流）→ 评审阶段
  （异模型 reviewer）。它只负责「按声明执行」，**不判断怎么拆**——拆分规则仍由 skill（§7）承担。
- **明确不做（docs/90 §6 否决项）**：不做文件碰撞检测、不做 claim 看板、不做 manifest 不相交校验。
  并发池只限制「同时跑几个会话」，与文件所有权无关。

## 3. 数据模型

迁移 **V48**（V47 已被 feat/github-tools 占用）。只新增三张表，不改 `task_bindings`：

```sql
workflows(
  id TEXT PRIMARY KEY,            -- = 父 TaskBinding id
  pools_json TEXT NOT NULL,       -- {"codex":2}
  status TEXT NOT NULL,           -- running | waiting_approval | done | failed（派生态的缓存，便于列表查询）
  created_at, updated_at
)
workflow_stages(
  workflow_id, stage_index,       -- PK
  stage_key TEXT NOT NULL,        -- 工作流内唯一，模板引用用它
  title, requires_approval INTEGER,
  status TEXT NOT NULL,           -- pending | running | waiting_approval | done | failed
  approved_at, approved_via,      -- 审批留痕（desktop / mcp）
  error, updated_at
)
workflow_tasks(
  workflow_id, stage_index, task_key,  -- PK = 幂等键
  spec_json TEXT NOT NULL,        -- 派发参数（prompt 模板、cliTool、projectPath、resultSchema …）
  pool TEXT NOT NULL,             -- 并发池名，缺省 = cliTool
  status TEXT NOT NULL,           -- pending | claimed | running | done | failed
  binding_id TEXT,                -- 子 TaskBinding（回执）
  result_json TEXT, error, updated_at
)
```

子 TaskBinding 上的约定（metadata，零迁移）：

| 键 | 含义 |
|---|---|
| `metadata.resultSchema` | 派发时给的 JSON Schema（`dispatch_task.resultSchema` 或阶段任务的 `resultSchema`） |
| `metadata.result` | worker 交回的结构化结果（已通过校验） |
| `metadata.workflowTask` | `{workflowId, stageIndex, taskKey}`：回执指针，恢复时用来认领 |

## 4. 状态机

### 4.1 阶段

```
pending ──(无需审批)──────────────▶ running ──(全部子任务 done)──▶ done
   │                                  │
   └─(requiresApproval 且未批)─▶ waiting_approval ──(approve_stage)──▶ running
                                      │
                                      └─(任一子任务 failed)──▶ failed（终态）
```

- 阶段严格按 `stage_index` 串行；**同一时刻只有一个阶段处于非终态推进**。
- `requiresApproval` 的语义是「进入本阶段前停下」——前一阶段完成后停在 `waiting_approval`；
  第一阶段也可以要求审批（创建后先等人点头）。
- 失败快速收敛：阶段内任一子任务失败 → 阶段 failed → 工作流 failed。已在跑的兄弟任务不强杀
  （杀会话是破坏性操作，交给人决定），只是不再派新的。

### 4.2 子任务

```
pending ─(驱动器 CAS 认领)─▶ claimed ─(派发成功，回填 binding_id)─▶ running
                                │                                     │
                                └─(派发报错)─▶ failed          (子 binding completed/failed)
                                                                      ▼
                                                                 done / failed
```

- `running → done` 要求子 binding `status = completed`；若任务声明了 `resultSchema`，还要求
  `metadata.result` 存在，否则判 failed（`missing structured result`）。
- 子 binding 被删除 → failed。

### 4.3 纯函数

状态推进全部在 `cc-panes-core/src/services/workflow_engine.rs` 的纯函数 `reduce(snapshot, observations)`
里完成：输入是工作流快照 + 子 binding 观测值（status / result / summary），输出是新快照 + 「本轮应派发的
任务列表」（已按并发池截断）+ 是否刚进入审批等待。副作用（写库、派发、通知）由驱动器执行。
单测覆盖每条转移边。

## 5. 驱动器（src-tauri）

`orchestrator_service/workflow_tools.rs` 里一个单消费者 tokio 任务，随编排服务启动：

- **唤醒源**：`create_workflow` / `approve_stage`（WorkflowService 的 waker）；子 binding 进入终态
  （TaskBindingService 的终态观察者——覆盖 MCP 更新、终端退出、UI 修改所有写入路径）；
  60s 兜底 tick（只查 `workflows.status IN (running, waiting_approval)`，无活跃工作流时近乎零开销）。
- **单消费者 = 进程内天然串行**：同一时刻只有一个协程在推进工作流，派发不会自己和自己抢。
- **派发**：复用 `run_durable_dispatch`（与 `dispatch_task` 同一条路径），`parentBindingId` = 工作流 id，
  prompt 先做模板渲染（§7）。

## 6. 幂等与恢复语义

**幂等键** = `(workflow_id, stage_index, task_key)`，即 `workflow_tasks` 主键。派发分三步，每步落库：

1. **认领（outbox）**：`UPDATE workflow_tasks SET status='claimed' WHERE ... AND status='pending'`，
   影响行数为 1 才继续。重复唤醒、重复 `approve_stage`、并发 tick 都过不了这道 CAS。
2. **派发**：子 binding 创建时 metadata 带 `workflowTask` 回执指针。
3. **回填（receipt）**：`binding_id` 写回、状态改 `running`。

**重启恢复**（驱动器启动时先于任何派发执行一次）：

| 崩溃时所处位置 | 库里看到的 | 恢复动作 |
|---|---|---|
| 认领前 | `pending` | 正常派发 |
| 认领后、子 binding 创建前 | `claimed`，找不到回执 binding | 退回 `pending` 重新派发（确定没有会话） |
| 子 binding 已建、会话已起（有 sessionId） | `claimed`，回执 binding 有 sessionId | 认领它：回填 `binding_id`，转 `running`，**不重派** |
| 子 binding 已建、没有 sessionId | `claimed`，回执 binding 无会话 | 判 failed（`interrupted during launch`）。无法证明没有起会话，宁可失败交人处理，也不冒重复起会话的险 |
| 派发完成 | `running` | 照常观测子 binding |

- **已完成的阶段不重跑**：`done` 是终态，`reduce` 永远从第一个非 done 阶段开始。
- **审批不丢**：`approved_at` 落库；app 关着时在别处批准，下次启动照常推进。
- **daemon 重启**：会话真身在 daemon；daemon 换代杀掉的会话会经 `record_terminal_exit` 把子 binding
  标 failed，工作流随之 failed——与普通派发语义一致，不额外复活。
- **父 binding 被删**：驱动器发现父 binding 不存在 → 工作流 failed（`parent binding deleted`）。

## 7. 结构化结果

- `dispatch_task` 可选 `resultSchema`（JSON Schema）。存进子 binding `metadata.resultSchema`，并在 prompt
  末尾追加一句「完成时用 update_task_binding 带 result 交回」的说明。**不传时行为与现在完全一致**
  （prompt、metadata、响应都不变）。
- `update_task_binding` / `report_to_leader` 可选 `result`（JSON）。有 schema 时先校验，
  不通过直接返回错误、**什么都不写**（worker 可修正后重试）；通过后合并写入 `metadata.result`，再写状态——
  保证观察者看到 completed 时结果已在库里。`report_to_leader` 投递给 leader 的那一行附带紧凑 JSON（截断 500 字）。
- 校验器是内置子集（`cc-panes-core/src/services/json_schema_lite.rs`）：`type`（含数组形式）、`properties`、
  `required`、`additionalProperties: false`、`items`、`enum`、`const`、`minLength/maxLength`、`minimum/maximum`、
  `minItems/maxItems`。不认识的关键字忽略（宽松），不拉 jsonschema 依赖树。
- **模板引用**：阶段任务的 prompt 可写
  - `{{prev}}` —— 上一阶段全部结果 `{taskKey: result}` 的 JSON；
  - `{{stages.<stageKey>}}` —— 指定阶段全部结果；
  - `{{stages.<stageKey>.<taskKey>}}` —— 单个任务结果。
  引用不存在的阶段/任务按原样保留占位符（不静默替换成空串，方便 worker 发现问题）。

## 8. 并发池

- `create_workflow` 可声明 `pools: {"codex": 2, "claude": 3}`；任务的 `pool` 缺省取其 `cliTool`
  （再缺省 `claude`）。未声明上限的池不限。
- 计数口径：**本工作流当前阶段**里 `claimed + running` 的任务数。超过上限的任务留在 `pending` 排队，
  子任务进入终态释放位置后由观察者唤醒补派。
- v1 只做工作流内的池，不做跨工作流的全局池（全局闸门是 task_queue 的职责，二者不混）。

## 9. MCP 面（ccpanes 编排 MCP，进 core 工具面）

| 工具 | 说明 |
|---|---|
| `create_workflow` | `stages[]`（每段 `key`、`requiresApproval?`、`tasks[]`），`pools?`，`parentBindingId?`；不给父 binding 时新建一个，并把调用方会话挂上去以便收汇报 |
| `approve_stage` | `workflowId` + `stageKey`（或 `stageIndex`）；只对 `waiting_approval` 生效，重复批准幂等 |
| `get_workflow_status` | 阶段 / 子任务状态、binding id、结构化结果 |

注册集中在 `orchestrator_service/workflow_tools.rs` 的独立 `#[tool_router(router = workflow_tool_router)]`，
主路由只做一次合并；`CORE_MCP_TOOLS` 只追加三行。

## 10. 审批通道

- **桌面**：编排面板树视图在父任务下显示阶段条和「批准」按钮（Tauri command `approve_workflow_stage`）。
- **通知**：进入 `waiting_approval` 时走 `NotificationService::trigger` 发一条桌面通知。
- **IM 双向审批**：仓库现有的 Telegram 审批按钮（`im_bridge/inbound/approvals.rs`）绑定的是 ACP 会话的
  `PermissionBinding`，语义是「批准一个正在等待的工具调用」，与工作流阶段对不上；v1 **不接**，
  留作后续：给 ApprovalBook 加一种 `WorkflowStage` 目标即可复用按钮与令牌账本。

## 11. 不做 / 遗留

- 失败阶段的「重试」：v1 失败即终态；要重来就建新工作流。
- 跨工作流全局并发池。
- REST（cc-panes-web）对等路由：v1 只在桌面编排服务里跑驱动器。
- IM 双向审批（§10）。

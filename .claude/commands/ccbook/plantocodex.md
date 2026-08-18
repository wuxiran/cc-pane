---
name: plantocodex
description: Plan → Codex 执行交接 — Claude 规划完写到 plan 文件，注册 leader/worker，把 plan 派给 Codex 实现，靠 worker 自动反馈 + 软超时监控完成。Claude 不写代码，Codex 写。
trigger: |
  - 用户说"plan-to-codex"、"先规划再交给 Codex"、"派给 Codex 实现"、"hand off this plan"
  - 已经有 plan（写了或刚写），准备让 Codex 按 plan 改代码
  不触发：
  - 用户想让 Claude 自己改代码 → 不走本 skill
  - 想派给另一个 Claude Code worker → /ccbook:plantocc
  - plan 还没做评审且涉及高风险 → 先走 /ccbook:planreview 评审
---

# plantocodex — Plan → Codex 执行交接

> **会话状态判读、停手规则与收尾字段以 [`docs/65 · Skill 观测契约`](../../../docs/65-skill-observation-contract.md) 为准**，本文不再复述。
> 三条最常踩的：`idle` + `turnSeq: 0` **且 PTY 零输出** = prompt 未提交（发裸 CR，**不要 kill 重发**）——
> 三个条件缺一不可；**PTY 有输出时多半是在等你选**，此时发 CR 会盲选一项；
> `status` 单独不可信，判活要看 `lastOutputAt` 停滞 + 进程存活；
> 动手写之前先核身份——`$CC_PANES_LAUNCH_ID` 必须等于所连 MCP URL 里的 `launchId`，不等即串台。

你是 Plan-to-Codex 编排 Agent。Claude 完成规划并把 plan 写到文件，**通过 cc-panes 的 leader/worker 机制**把 plan 交给 Codex 执行，monitor 完成事件（worker 自动 PTY 反馈 + TaskBinding 持久化 + 软超时兜底），最后汇报。

> **Claude 不写代码** —— 代码由 Codex 完成。

---

## 何时用 / 何时不用

**用**：
- Plan 已经写好（或本轮即将写好），要派 Codex 实现
- 实现工作量大、Claude 自己做会浪费 context，或者用户想 Codex 主动审一下再实现
- 想要 Codex 在 WSL/本地新窗口跑，不阻塞当前 Claude

**不用**：
- 用户希望 Claude 自己改代码
- 小到不值得一个新 Codex 实例（< 50 行简单 patch）
- Plan 还没经过同行评审且涉及高风险 → 先走 [`/ccbook:planreview`](planreview.md) 评审，再用本 skill 派实现

---

## 前置检查

1. **plan 文件已落盘**？没有则先按 planreview 的"plan mode 与 Write 的单一路径策略"写到 `.claude/plans/<topic>.md`。记 `<plan_path>`。
2. **ccpanes 已注册当前项目 + 目标 worktree**？`mcp__ccpanes__list_projects` 确认。WSL 启动要用其中已登记的 UNC 路径（`\\wsl.localhost\Ubuntu\...`）或 `/mnt/...`。
3. **当前 Claude 自己的 sessionId**？读环境变量 `CC_PANES_PTY_SESSION_ID`。这是注册 leader 的前提，否则 worker 反馈推不到你这边。

---

## 拆分判定与 CLI 路由（写 plan / 派工前先走一遍）

拆不拆、拆几份、派给谁，不靠感觉——按下面的判定程序走，全部是是非题 + 硬阈值。**走完算出 N=1 是合法且常见的答案，不是流程失败**。

### 形状三问（按序问，命中即停）

1. 能列出 **≥6 个独立可交付项**，且做完任一项不需要读另一项的产出？→ **宽任务**，走聚簇。
2. 需要新增/修改跨 Rust-TS 边界的接口（command 签名、类型、事件契约；非 Rust/TS 项目按前后端边界同理）？→ **深任务**，走扇出。
3. 还说不清要改哪些文件？→ **探索任务：禁止拆分**。单 agent 干，最多派只读子 agent 做研究。

### 宽任务聚簇

- 按「同族」聚簇（同一 CRUD 家族 / 同一目录 / 同一模式的重复项），**不按单项派工**。
- 单簇预估实现 **≥30 分钟**（不足则合并相邻簇）、**≤3 小时**（超则对半切）。
- N 上限看验收方式：验收 = 测试+编译（机器判）→ **N ≤ 8**；验收需 leader 读 diff → **N ≤ 3**。

### 深任务扇出

- **强制前置**：契约（模型结构体、command 签名、TS 类型、事件契约条目、测试骨架）先写完并**提交成 commit**；契约未提交，禁止派任何 worker。
- 切缝白名单四选：**Rust 侧 / TS service+store 侧 / 组件侧 / 测试侧**，即 **N ≤ 4**，不允许更细。
- 任一侧预估 **<30 分钟** → 并入相邻侧，实际 N 缩小。
- 深任务**序列**的提速不靠加宽，走流水线错位：worker 实现功能 n 时，leader plan 功能 n+1、reviewer 审功能 n-1。

### 派发门（每个 worker 单元过三关，任一不过即回炉）

1. 验收判据能写成**一句可执行的话**（「X 测试过 + `cargo check -p Y` 过」）？写不出 = 缝切歪了，重切。
2. 该单元整个报废重做的损失 **≤3 小时**？超了 = 太粗，切开。
3. leader 验收此单元 **≤10 分钟**？超了 = 要么自动化验收，要么合并单元降 N。

### CLI 路由（每个过门单元选执行者）

1. **默认 Claude**（同模型可传意图，通信成本最低）。以下命中才改派。
2. **规格自足才可派 Codex**：该单元的简报 + 文件所有权清单 + 契约已写到「不需要知道本仓库怎么做事、照做即可」？是 → 可派 Codex；否 → 补写到自足（然后可派），或留 Claude。**禁止把规格不自足的单元派给 Codex**——跨模型只能传规格，不能传意图。
3. **机械簇 Codex 优先**：宽任务簇同时满足「规格自足 + 验收机器判」→ Codex 优先（省 Claude 配额，机械重复对先验依赖最低）。
4. **评审强制异模型**：交叉评审 / plan review 类只读单元必须派非 leader 同模型（Codex 审 Claude，专治「我审我」盲区）。这是唯一强制改派的类别。
5. **Grok 可作第三方视角，但规格自足要求最高**：leader 是 Claude、Codex 已占用时可派 Grok（[`/ccbook:plantogrok`](plantogrok.md)）。注意它**读不到任何内置 skill**（挂载通道只覆盖 Claude/Codex），一切约定必须写进 prompt 正文；且其 MCP URL 无 `launchId`，多 worker 并发时身份不可辨，`workerId` 必须写死传对。
6. **契约设计与集成收尾不外派**：深任务这两段语义密度最高，leader 自己做。
7. **WSL Codex 守则**：prompt 未提交假死 → 发裸 CR，不要 kill 重发；启动前确认 WSL 内 CLI 是原生 ELF（`type -a codex` 第一条不能是 `/mnt/` 下的 `.exe`）。

### 派工通信四原则

- **共享物优先于转述**：leader 验收看 diff 与证据，不看 worker 的自我汇报。
- **声明带证据指针**：完成报告 = 改动文件列表 + 每项验收的命令与退出码（用 `PIPESTATUS` 判定，别被 `| tail` 掩码）+ 偏离说明；信任降为抽查。
- **死路显式传递**：踩到的坑按「症状→判定→解法」格式写进共享 memory 池（`mcp__ccpanes__memory_add`），跨实例复用。
- **跨模型传规格、同模型可传意图**：给 Codex 的 plan 显式度必须高于给 Claude 的。

> 阈值（≥6 项 / 30min~3h / ≤3h 报废 / ≤10min 验收 / N≤8 / N≤3 / N≤4）是初始标定值，随实测的加速比与返工率修订。

---

## 可选：worktree 隔离模式

**何时启用**（任一命中，或用户提到 "worktree"，或经 `/plantoworktree` 入口进来）：
- 任务预计长时间运行，且用户要继续在主树干活
- 高风险改动（大范围重构 / 批量删改文件）
- 同一仓库已有另一个写代码的 worker 在跑

**派发前增量**（替代"直接用主仓库路径"）：

1. 建 worktree（命名约定 `<repo>@<slug>`，与主仓库同级）：
   `git -C <主仓库> worktree add ../<repo>@<slug> -b <slug>`
2. 拷贝未跟踪运行时文件——`git worktree` 不带未跟踪文件，漏拷会构建失败。常见清单：`.env`、`.env.local`、本地证书；按项目实际情况问一句用户
3. 注册进工作空间（provider/launch/runtime 配置自动继承自工作空间，无需任何额外配置）：
   `mcp__ccpanes__add_project_to_workspace(workspaceName, projectPath: <worktree 绝对路径>)`
4. 之后 Phase 3/4 的 `projectPath` 全部指向 worktree 路径（WSL 转换规则同下表）

**收尾增量**（Phase 7 用户确认后追加）：

1. 主仓库 merge / cherry-pick 该分支（或用户明确弃置）
2. 脏树检查：worktree 内无未提交改动才允许移除，有则先问用户
3. `git worktree remove <路径>` + `git branch -d <slug>`
4. 提醒用户在 CC-Panes UI 手动移除该项目节点（移除项目无 MCP 工具，是刻意的破坏性操作限制）

**不启用时**：一切照旧，worker 直接在主仓库路径干活。

---

## 执行步骤

### Phase 1：完成 plan + 记下路径

按常规 plan mode 流程探索 + 设计，把 plan 写到 `.claude/plans/<topic>.md`。

### Phase 2：注册 leader（worker 自动反馈的前提）

```
mcp__ccpanes__register_plan_leader(
  planPath: <plan_path 原样 Windows 路径>,
  projectPath: <主仓库或目标 worktree 已注册路径>,
  cliTool: "claude",
  sessionId: <CC_PANES_PTY_SESSION_ID 环境变量>,
  title: "Plan-to-Codex leader: <plan 简短描述>",
  workspaceName: <workspace 名,可选>
)
```

记下返回的 `id` 作为 `<leaderId>`。

### Phase 3：确认 Codex 目标 + 路径

用 `AskUserQuestion` 问：

```
问题: 把 plan 派给哪个 Codex?
  - 新建 Codex 窗口（本地）
  - 新建 Codex 窗口（WSL）           ← 跨工具盲点最大
  - 复用已有窗口（告诉我标签名）
```

**WSL 路径转换表**（喂给 Codex prompt 用，**不是 launch_task.projectPath**）：

| 输入 | 转换 |
|------|------|
| `C:\Users\foo\.claude\plans\x.md` | `/mnt/c/Users/foo/.claude/plans/x.md` |
| `D:\code\repo\src\foo.rs` | `/mnt/d/code/repo/src/foo.rs`（盘符小写） |
| `D:\路径 含空格\plan.md` | `/mnt/d/路径 含空格/plan.md`（独立行/代码块包路径） |
| `\\wsl.localhost\Ubuntu\home\foo\proj` | `/home/foo/proj` |
| `\\wsl$\Ubuntu\mnt\d\code` | `/mnt/d/code` |
| 已是 `/home/...` 或 `/mnt/...` | 原样 |
| Windows junction / symlink | 在 WSL 里 `wslpath -u "<windows>"` 自动转 |

**`launch_task.projectPath` 必须用 `list_projects` 取到的原样字符串**（不要自己拼），再配 `runtimeKind: "wsl"`。

### Phase 4：启动 Codex + 注册 worker

**新建窗口**：

```
mcp__ccpanes__launch_task(
  projectPath: <list_projects 取到的已注册路径>,
  cliTool: "codex",
  runtimeKind: "wsl" | "local",      // 与项目路径一致
  title: "Codex: <简短描述>",
  prompt: <见下方 prompt 模板>
)
```

记录返回的 `sessionId` 为 `<workerSessionId>`。

**立即注册 worker**（leader 来做）：

```
mcp__ccpanes__register_plan_worker(
  leaderId: <Phase 2 拿到的>,
  sessionId: <workerSessionId>,
  projectPath: <同 launch_task>,
  cliTool: "codex",
  title: "Codex executor"
)
```

返回的 `id` 是 `<workerId>` —— **必须**填进 prompt 模板的"收尾要求"段。

**复用已有窗口**：

```
mcp__ccpanes__submit_to_session(
  sessionId: <匹配到的 sessionId>,
  text: <prompt 模板,自动处理回车时序>
)
```

> `submit_to_session` 自动处理 Claude/Codex (ink) 的提交时序。`write_to_session` 只用于发原始字节（如 Ctrl+C = `"\x03"`）。

### Phase 5：监控完成

**先核复述握手**：worker 的第一条回复应复述任务 + 列出将改文件清单。`get_session_output(lines: 100)` 核对，与派发意图不符 → 立即 `submit_to_session` 纠正；核对通过才算真正开工。

**首选：等 PTY 自动反馈**

worker 调 `report_to_leader` 时，PTY 会直接把 `[worker-report] id=... status=completed summary=...` 推到 leader 对话里。**不用主动 poll。**

**但**：如果 leader 此刻正在 thinking（执行其他工具调用），PTY 反馈返回 `{sent: false, queued: true, skipReason: "leader busy"}`——引擎会排队，leader 回到空闲时自动补投，不会丢。补投队列仅在 leader 崩溃/exited 时被清空，所以 prompt 仍必须要求 Codex 调 `update_task_binding` 持久化状态（reconcile 的唯一依据）。

**软超时兜底**（不强制 kill，给用户选）：

| 时刻 | 动作 |
|------|------|
| T+5min | `get_session_status(<workerSessionId>)` 看 `lastOutputAt`（30s 内有输出就继续等） |
| T+10min | 仍没收到 report 且 `lastOutputAt` 停了 → `get_session_output(lines: 200)` 抓尾部 + `AskUserQuestion` 给用户选「继续等 / 读取部分输出 / 发提醒 / kill_session 重发」|
| T+15min | 用户没响应且 worker 不动 → 默认推荐 kill 重发 |

**最终兜底**：`reconcile_plan_collaboration(leaderId)` 扫一遍 worker binding，看是否漏 report 的 worker 其实已经 `update_task_binding(completed)`。

**状态枚举**（必读，旧文档写错过）：

| 类别 | 值 | 含义 |
|------|-----|------|
| 仍在跑 | `active`, `thinking`, `initializing`, `toolRunning`, `compacting` | 继续等 |
| 需要交互 | `waitingInput` | 结合输出尾部判断：评审已完成回到提示符，还是真的卡住等用户 |
| 终止 | `idle`, `exited` | 进 Phase 6 |
| 错误 | `error` | 立即 `get_session_output` 排查 |

### Phase 6：读输出 + 验证

```
mcp__ccpanes__get_session_output(<workerSessionId>, lines: 500)
git diff --stat <worktree-or-main>
git diff <worktree-or-main>
```

汇报给用户：
- Codex 完成了哪些步骤
- 代码变更摘要（按文件）
- 是否有错误 / 未完成的部分
- 是否跑了测试

> 验收口径（共享物优先于转述）：看 diff 与证据指针（命令 + 退出码），不采信 worker 的纯文字自评。

### Phase 7：下一步建议

- 跑测试 / lint
- 让用户审 diff
- 决定是否在主仓库合并
- **不主动 commit** —— 等用户确认
- 收尾时在 plan 文件末尾追记两行度量（攒数据修订拆分阈值）：
  `墙钟: <实际> vs 单agent估计: <估>`、`返工率: <丢弃/重做的比例或"零">`

---

## Codex Prompt 模板

```
请阅读并按此 plan 实现代码,不要修改 plan 本身。

## Plan 文件
<plan_path,已转 WSL 路径,独立一行>

## 上下文
- 项目根: <项目路径,WSL 形式>
- 关键约束: <如"不引入新依赖"、"保持现有 API 兼容">

## 简报(leader 预写,同批 worker 复用同一份)
<相关代码地图 + 契约位置 + 本单元上下文,压缩成一段>

## 文件所有权
- 独占写: <本单元允许修改的文件清单>
- 只读契约: <契约/接口文件,只许读不许改>
- 禁改: <其他在途并行单元的文件>

## 开工前复述
第一条回复先用自己的话复述任务,并列出将修改的文件清单;
与上面所有权清单不符时停下等 leader 纠正,核对通过才算开工。

## 工作流
1. 完整读 plan
2. 按 plan 顺序实现,每完成一个 phase 跑一次相关测试
3. 遇到 plan 与代码现状不符 → 停下来记录,不擅自改 plan
4. 全部完成后:
   - git diff --stat 汇总改动
   - 报告 = 改动文件列表 + 每项验收的命令与退出码(证据指针) + 偏离说明

## 收尾(必须执行,不能跳)
1. 先持久化状态(防 PTY 反馈丢失):
   mcp__ccpanes__update_task_binding(
     id: "<填 Phase 4 拿到的 workerId>",
     status: "completed",
     progress: 100,
     completionSummary: "已完成 N 个 phase,改动 M 文件"
   )
2. 再 PTY 上报 leader:
   mcp__ccpanes__report_to_leader(
     workerId: "<同上 workerId>",
     status: "completed",
     summary: "Codex 执行完成,改动 M 文件,详见 PTY"
   )
3. 如果 report_to_leader 返回 {sent: false, queued: true, skipReason: "leader busy"},
   不重试 — 引擎已排队,leader 空闲后会自动收到补投;TaskBinding 也已持久化兜底。
4. **不要调 trigger_notification**——worker 的汇报对象是 leader 不是用户;
   由 leader 汇总整个编队后统一发一条通知,worker 各自发 = 通知轰炸。
```

---

## 与 planreview 的区别

| 维度 | planreview | plantocodex |
|------|------------|-------------|
| Codex 角色 | 评审 plan | 执行 plan |
| 是否改代码 | 否 | 是 |
| Plan 后续 | Claude 重写 plan | 不改 plan,改代码 |
| 用户拍板 | 必须（评审条目逐条） | 不必（执行类） |
| 退出 plan mode | 评审吸收完之后 | Codex 启动前 |
| 串联 | planreview 输出已评审 planPath | plantocodex 接同一 planPath |

**推荐串联**（高风险 plan）：`planreview` 评审 → 用户拍板 → 重写 plan → 用户 ExitPlanMode → `plantocodex` 派实现（WSL 环境细节见 [`/ccbook:plan2codexwsl`](plan2codexwsl.md)）。

---

## 反模式

- ❌ 用 `CronCreate` 每分钟轮询 → 烧 token，且 cc-panes 已内置 worker 自动反馈
- ❌ 跳过 `register_plan_leader` / `register_plan_worker` → PTY 反馈无目标
- ❌ Codex prompt 不要求 `update_task_binding` → leader 崩溃/退出时补投队列被清，主 Agent 永远收不到通知
- ❌ 把 `get_session_status` 返回的 `active/idle/exited` 当作完整枚举 → 漏掉 thinking/waitingInput/error
- ❌ `launch_task.projectPath` 自己拼 `/mnt/...` → 不匹配 cc-panes 注册路径，启动失败
- ❌ "超过 10 分钟提醒用户"作为唯一兜底 → 没有渐进性，体验差
- ❌ Claude 自己改代码 → 和本 skill 角色冲突（评审也不改代码，见 planreview）

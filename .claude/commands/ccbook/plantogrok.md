---
name: plantogrok
description: Plan → Grok worker 执行交接 — 把 plan 派给 Grok CLI 实例实现。流程同 plantocodex（leader/worker 注册 + 自动反馈 + 软超时），本文只写 Grok worker 的差异：`--no-plan` 禁规划、权限六档、MCP 无 launchId 身份降级、无内置 skill。
trigger: |
  - 用户说"派给 grok"、"plan 给 grok 做"、"开个 Grok 实例实现这个 plan"、"plantogrok"
  - 已有 plan，希望由 Grok CLI 执行——想要第三方模型视角，或需要 Grok 原生 worktree
  不触发：
  - 派给 Codex 执行 → /ccbook:plantocodex（WSL 细节 → /ccbook:plan2codexwsl）
  - 派给另一个 Claude → /ccbook:plantocc
  - plan 评审 → /ccbook:planreview
---

# plantogrok — Plan → Grok worker 执行交接

> **会话状态判读、停手规则与收尾字段以 [`docs/65 · Skill 观测契约`](../../../docs/65-skill-observation-contract.md) 为准**，本文不再复述。
> 三条最常踩的：`idle` + `turnSeq: 0` **且 PTY 零输出** = prompt 未提交（发裸 CR，**不要 kill 重发**）——
> 三个条件缺一不可；**PTY 有输出时多半是在等你选**，此时发 CR 会盲选一项；
> `status` 单独不可信，判活要看 `lastOutputAt` 停滞 + 进程存活；
> 动手写之前先核身份——`$CC_PANES_LAUNCH_ID` 必须等于所连 MCP URL 里的 `launchId`，不等即串台。

把 plan 派给 **Grok CLI 实例**执行。编排骨架（Phase 1-7：写 plan → 注册 leader → launch worker → 注册 worker → 监控 → 读输出验证 → 汇报）**完全复用 [`/ccbook:plantocodex`](plantocodex.md)**，只需把 `cliTool` 换成 `"grok"` 并注意下面的 Grok 特有差异。

> **主 Agent（leader）不写代码**——代码由 Grok worker 完成。

---

## 先过拆分判定与路由

派工前先走 [`/ccbook:plantocodex`](plantocodex.md) 的「拆分判定与 CLI 路由」节（形状三问 → 聚簇/扇出 → 派发门三关 → CLI 路由），本 skill 不重复规则。与派 Grok worker 直接相关的三条：

- **规格自足要求比 Codex 还高一档**（见差异 5）：Grok worker 读不到任何内置 skill，一切约定必须写死进 prompt 文本。规格不自足 → 不要派 Grok。
- **可作为评审的异模型**：leader 是 Claude、Codex 已占用时，Grok 是合法的第三方视角。但评审仍优先走 [`/ccbook:planreview`](planreview.md)。
- **N=1 是合法答案**：判定算出不值得拆就单 agent 顺序做，不硬派。

---

## 与派 Codex 的差异（必读）

### 1. 禁规划走 flag，不靠 prompt 措辞

Codex 无 plan mode 概念；Claude 要靠 prompt 开头写一行"不要进入 plan mode"（plantocc §2）。**Grok 两者都不是——它有原生 `--no-plan`**，比措辞可靠得多（措辞会被模型无视，flag 不会）。

派工时若担心 worker 自行进入规划循环，通过启动配置的 extraArgs 传 `--no-plan`。另注意 `--permission-mode` 也有 `plan` 档，别误设成它。

### 2. 权限是六档不是二元

Codex 默认能在沙箱干活；Claude 是二元（弹确认 / `--dangerously-skip-permissions`）。**Grok 有 `--permission-mode` 六档**：`default` / `acceptEdits` / `auto` / `dontAsk` / `bypassPermissions` / `plan`。

- CC-Panes 的 YOLO 开关映射到 `--always-approve`（**不是** Claude 那个 flag，照抄会传出非法参数）
- 无人值守派工至少要 YOLO，否则 worker 停在权限确认永远等你
- 想要中间档（比如只自动批准编辑、不自动跑命令）→ 通过 extraArgs 传 `--permission-mode acceptEdits`

### 3. MCP 身份无 launchId —— Grok 独有、最重的一条

Grok 没有 per-launch MCP override 通道（`-c` 是 `--continue` 不是 config override），所有 grok 会话**共享同一个 ccpanes MCP entry**，URL 里**不带 `launchId`**。后果：

**Orchestrator 无法从 caller 身份反推是哪个 grok 会话在调用。** 所以：

- worker prompt 的收尾段里，`workerId` **必须显式写死传对**——不能指望服务端反推，也不能让 worker "自己查一下"
- 同时派多个 grok worker 时尤其危险：它们在 orchestrator 眼里身份不可分，**workerId 传错 = 汇报记到别的 worker 头上，且没有任何报错**
- 派发前把 `register_plan_worker` 返回的 `workerId` 原样拼进 prompt，不要用变量占位让 worker 自己填

### 4. 无内置 skill —— 规格自足要求最高

CC-Panes 的内置 skill 挂载只覆盖 Claude（`--plugin-dir`）与 Codex（`skills.config`）两条通道，**Grok 一条都没有**。含义：

- Grok worker 读不到 `/ccpanes:*` 任何 skill，包括收尾流程、观测契约、finish-work
- 一切约定必须**写进 prompt 正文**：收尾双写的两个工具调用、文件所有权清单、验收口径、不发通知
- 引用 skill 名（"按 finish-work 收尾"）对 Grok worker 是无效指令——它看不到那个文件

### 5. 监控只能靠 OSC + PTY 输出

`supports_project_hooks: false`：项目级 cli-hooks 对 Grok worker 不生效，出错时没有 hook 侧的状态跃迁。软超时三级表（plantocodex Phase 5）照常用，但判活更依赖 `lastOutputAt` 与 `get_session_output` 尾部。

### 6. resume 比 Codex 稳（正面理由）

Grok 走**发号模式**（`--session-id` 预发确定性 UUID，同 Claude），**不依赖 OSC 标题捕获**——不存在 docs/45 那类「CLI 升版打断捕获链导致 resumeId 全 null」的风险。长任务中途要接管时这点很值钱。

### 7. 原生 worktree（正面理由）

Grok 自带 `-w/--worktree [名称]` 与 `--worktree-ref <基点>`，比 plantocodex「worktree 隔离模式」的手工建树省事。同项目并行多个 worker 改代码时可直接用它隔离。

### 8. launch 参数

```
mcp__ccpanes__launch_task(
  projectPath: <list_projects 已注册路径原样>,
  cliTool: "grok",
  runtimeKind: "wsl",        // 本地省略；WSL 路径细节见 /ccbook:plan2codexwsl
  title: "Grok executor: <plan 简短描述>",
  prompt: <plantocodex 模板 + 差异 3 的 workerId 写死 + 差异 4 的约定内联>
)
```

per-launch 参数支持情况：**effort（`--reasoning-effort`）与 maxTurns（`--max-turns`）生效**；**verbose 不支持**（Grok 只有 `--debug`，语义是写日志，启动器里已置灰）。

---

## 何时选 Grok worker

| 选 Grok worker | 选别的 |
|---------------|--------|
| 想要第三方模型视角（leader 是 Claude、Codex 已占用） | 需要内置 skill 生态 → Claude（[`/ccbook:plantocc`](plantocc.md)） |
| 长任务要中途接管（resume 链路比 Codex 稳） | 规格写不到完全自足 → Claude（同模型可传意图） |
| 要并行隔离（原生 worktree 最省事） | 评审类只读单元 → [`/ccbook:planreview`](planreview.md) |
| 机械簇、验收可机器判 | 需要多 worker 身份可辨的复杂编排 → 避开 Grok（差异 3） |

---

## 完整流程去哪看

| 事项 | 去处 |
|------|------|
| Phase 1-7 全流程、prompt 模板、软超时表、反模式 | [`/ccbook:plantocodex`](plantocodex.md)（cliTool 换 "grok"） |
| WSL 路径转换 / 已注册路径 | [`/ccbook:plan2codexwsl`](plan2codexwsl.md) |
| 先评审再派活 | [`/ccbook:planreview`](planreview.md) |
| 多 worker 并行 + worktree | [`/ccbook:parallel`](parallel.md) |

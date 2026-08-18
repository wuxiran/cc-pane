---
name: plantocc
description: Plan → Claude Code worker 执行交接 — 把 plan 派给另一个 Claude Code 实例实现。流程同 plantocodex（leader/worker 注册 + 自动反馈 + 软超时），本文只写 Claude worker 的差异：权限确认/YOLO、plan mode 禁入、waitingInput 判读。
trigger: |
  - 用户说"派给另一个 claude"、"plan 给 cc worker"、"开个 Claude 实例实现这个 plan"、"plantocc"
  - 已有 plan，希望由 Claude Code（而非 Codex）执行——需要 Claude 的工具生态（skills/MCP/subagent）或统一模型行为
  不触发：
  - 派给 Codex 执行 → /ccbook:plantocodex（WSL 细节 → /ccbook:plan2codexwsl）
  - plan 评审 → /ccbook:planreview
---

# plantocc — Plan → Claude Code worker 执行交接

> **会话状态判读、停手规则与收尾字段以 [`docs/65 · Skill 观测契约`](../../../docs/65-skill-observation-contract.md) 为准**，本文不再复述。
> 三条最常踩的：`idle` + `turnSeq: 0` **且 PTY 零输出** = prompt 未提交（发裸 CR，**不要 kill 重发**）——
> 三个条件缺一不可；**PTY 有输出时多半是在等你选**，此时发 CR 会盲选一项；
> `status` 单独不可信，判活要看 `lastOutputAt` 停滞 + 进程存活；
> 动手写之前先核身份——`$CC_PANES_LAUNCH_ID` 必须等于所连 MCP URL 里的 `launchId`，不等即串台。

把 plan 派给**另一个 Claude Code 实例**执行。编排骨架（Phase 1-7：写 plan → 注册 leader → launch worker → 注册 worker → 监控 → 读输出验证 → 汇报）**完全复用 [`/ccbook:plantocodex`](plantocodex.md)**，只需把 `cliTool` 换成 `"claude"` 并注意下面的 Claude 特有差异。plantocodex 的「可选：worktree 隔离模式」对 Claude worker 同样适用（触发条件与增量步骤原样沿用）。

> **主 Agent（leader）不写代码**——代码由 Claude worker 完成。

---

## 先过拆分判定与路由

派工前先走 [`/ccbook:plantocodex`](plantocodex.md) 的「拆分判定与 CLI 路由」节（形状三问 → 聚簇/扇出 → 派发门三关 → CLI 路由），本 skill 不重复规则。与派 Claude worker 直接相关的三条：

- **默认 Claude 即本 skill 场景**（路由第 1 条）：同模型可传意图，规格不必写到 Codex 级自足；但简报 + 文件所有权清单 + 开工前复述握手仍必须进 prompt（模板沿用 plantocodex）。
- **评审强制异模型**：评审类只读单元**不要**派 Claude worker——同模型是「我审我」盲区，走 [`/ccbook:planreview`](planreview.md)（Codex 审）。
- **N=1 是合法答案**：判定算出不值得拆就单 agent 顺序做，不硬派。

---

## 与派 Codex 的差异（必读）

### 1. 权限确认会卡死 worker —— 启动前必须解决 YOLO

Codex worker 默认能在沙箱里干活；**Claude worker 默认每个写操作都弹权限确认**，无人值守时会永远停在 `waitingInput`。`launch_task` 没有 launchProfileId 参数，YOLO 只能来自**工作空间/项目绑定的启动配置**：

- 启动前检查：目标项目所在 workspace（或项目本身）是否绑定了 `targetTools` 含 `claude` 且开了 YOLO 的启动配置（YOLO 对 Claude 映射为 `--dangerously-skip-permissions`）
- 没绑定 → `AskUserQuestion` 让用户选：去 UI 绑一个 claude YOLO 配置再来 / 接受 worker 会频繁 `waitingInput`、由用户在窗口里手动放行
- **不要**默默启动然后让软超时把"卡在权限确认"误判为"卡死 kill 重发"

### 2. worker prompt 必须禁入 plan mode

Claude 收到"按 plan 实现"类 prompt 可能自己 `EnterPlanMode` 再规划一轮——白烧 token 且永远等不到代码。prompt 模板（沿用 plantocodex 的骨架）开头加一行：

```
直接实现，不要进入 plan mode，不要重新规划——plan 已经定稿，逐条执行即可。
```

### 3. waitingInput 的判读不同

监控阶段（plantocodex Phase 5 的状态表）里，Claude worker 的 `waitingInput` 有三种可能，先 `get_session_output(lines: 100)` 看尾部再决策：

| 尾部内容 | 含义 | 动作 |
|---------|------|------|
| 权限确认框（Allow/Deny） | 没配 YOLO | 提示用户去窗口放行，或 kill 后绑 YOLO 配置重发 |
| AskUserQuestion 选项 | worker 在问业务取舍 | 把问题转给用户，拿到答案后 `submit_to_session` 回填 |
| 空提示符 + 完成总结 | 已完工但没调收尾工具 | 直接进验证阶段，reconcile 兜底 |

### 4. 收尾上报（与 Codex 相同，别省）

worker prompt 的收尾段照抄 plantocodex：先 `update_task_binding(status:"completed", ...)` 持久化，再 `report_to_leader(workerId, ...)`；返回 `{sent:false, queued:true}` 无需重试（引擎补投）。Claude worker 同样通过注入的 `ccpanes` MCP 调这两个工具。

### 5. launch 参数

```
mcp__ccpanes__launch_task(
  projectPath: <list_projects 已注册路径原样>,
  cliTool: "claude",
  runtimeKind: "wsl",        // 本地省略；WSL 路径细节见 /ccbook:plan2codexwsl
  title: "CC executor: <plan 简短描述>",
  prompt: <plantocodex 模板 + 上面第 2 节的禁入 plan mode 行>
)
```

同项目并行多个 Claude worker 改代码 → 必须 worktree 隔离（见 [`/ccbook:parallel`](parallel.md)）。

---

## 何时选 Claude worker 而不是 Codex

| 选 Claude worker | 选 Codex worker（plantocodex） |
|-----------------|------------------------------|
| plan 依赖项目 skills / subagent / MCP 生态 | 纯代码实现、改动集中 |
| 希望 worker 行为与 leader 同构、prompt 约定一致 | 想要跨模型视角（leader 是 Claude 时） |
| 已绑 claude YOLO 启动配置 | 不想处理 Claude 权限确认 |

---

## 完整流程去哪看

| 事项 | 去处 |
|------|------|
| Phase 1-7 全流程、prompt 模板、软超时表、反模式 | [`/ccbook:plantocodex`](plantocodex.md)（cliTool 换 "claude"） |
| WSL 路径转换 / 已注册路径 | [`/ccbook:plan2codexwsl`](plan2codexwsl.md) |
| 先评审再派活 | [`/ccbook:planreview`](planreview.md) |
| 派给 Grok 而非 Claude | [`/ccbook:plantogrok`](plantogrok.md) |
| 多 worker 并行 + worktree | [`/ccbook:parallel`](parallel.md) |

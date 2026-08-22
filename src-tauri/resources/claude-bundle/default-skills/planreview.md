---
name: ccpanes-planreview
description: 在 plan mode 内启动另一个兼容 CLI（本地或 WSL）做同行评审。用于高风险 plan 二审或用户要求跨 CLI peer review。
---

# planreview — 跨 CLI Plan 同行评审

你是 Plan 同行评审编排 Agent。当前实例写完 plan 后，按用户偏好和启动配置选择另一个兼容 CLI（本地或 WSL）独立审 plan，**通过 `dispatch_task` 持久化派发和可选 PTY 反馈**，把结构化反馈拿回来，由用户分批拍板后整体重写 plan。

> 单一实例审自己写的 plan 容易有"我审我"盲区。优先换一个不同 CLI 实例读同一份 plan + 同一份代码，能挖出操作错误假设、UI 不可达控件、数据耦合、回滚遗漏等盲点。

> `dispatch_task` 支持所有已注册的内置 CLI。目标没有 MCP 时仍可做只读评审，但完成状态以 PTY 输出、会话状态和实际评审文本为准；不要承诺自动 `report_to_leader`。

> 本 skill 只管**评审**。要把 plan 派给任意 CLI **执行**，使用 [`/ccpanes:dispatch-task`](dispatch-task.md)；Codex WSL 的特殊排障仍见 [`/ccpanes:plan2codexwsl`](plan2codexwsl.md)。

---

## 何时用 / 何时不用

**用**：

- Plan 涉及 **UI 端到端测试** / **数据迁移与回滚** / **跨服务时序** / **线上变更**
- Plan 文件 ≥ 50 行，含多阶段步骤、SQL、回滚脚本、兜底逻辑
- 用户提到"想找另一个 CLI/codex/claude 审一下"、"换个角度看"、"再 review 一遍"
- 风险高、改错代价大、用户希望留下可审计的 reviewer 对话窗口

**不用**：

- 纯代码 refactor、单文件改动、< 30 行 plan
- 用户明说"我自己看就行 / 不要再叫 codex"
- 用户指定的目标 CLI 未安装，且不愿换兼容工具
- 已经走完一轮评审、用户在二轮迭代（这种直接改 plan，不重复启 reviewer）

---

## 前置检查（开干前都要过）

1. **当前在 plan mode 吗？** 否则提醒用户先 `EnterPlanMode`，写完初版 plan 再回来
2. **能写 plan 文件吗？** — 见下方"plan mode 与 Write 的单一路径策略"
3. **目标 reviewer 用哪个 CLI、走本地还是 WSL？** 直接 `AskUserQuestion` 问用户（不要靠 `list_launch_history` 猜——历史可能为空或含已废弃会话）。优先异 CLI；用户指定同 CLI 时照做。
4. **ccpanes 已注册当前项目？** 调 `mcp__ccpanes__list_projects`，**WSL 启动必须用其中已注册的项目路径**（UNC `\\wsl.localhost\Ubuntu\...` 或 `/mnt/...` 都可能存在，挑已注册那条）。缺则提示用户先 `add_project_to_workspace(workspaceName, projectPath)`

### plan mode 与 Write 的单一路径策略

不要反复 `ExitPlanMode → Write → EnterPlanMode`，每次切换都打断用户。按这个**单一顺序**走：

- **路径 A（首选，CC-Panes 项目默认）**：项目 hook 已放行 `.claude/plans/` 写入（cc-book 是这样）→ 直接 `Write` 到 `.claude/plans/<topic>.md`，**整个流程都在 plan mode 内完成**。
- **路径 B（hook 没放行时）**：第一次写 plan 就 `ExitPlanMode` 拿用户授权，**之后整个评审 + 重写都在 plan mode 外完成**；最后用户自己决定要不要再 `EnterPlanMode` 复审。**不要再 EnterPlanMode 回到 plan mode 然后又被 Write 拦**。

试一次 `Write` 即可探出当前在哪条路径。记下 `<plan_path>` 作绝对路径，后续所有调用都用它。

### WSL 路径转换规则（reviewer 跑 WSL 时）

| 输入 | 转换后（喂给 WSL CLI 的 prompt 文本） |
|------|----------------------|
| `C:\Users\foo\.claude\plans\x.md` | `/mnt/c/Users/foo/.claude/plans/x.md` |
| `D:\code\erp\docs\spec.md` | `/mnt/d/code/erp/docs/spec.md`（盘符全部小写） |
| `D:\路径 含空格\plan.md` | `/mnt/d/路径 含空格/plan.md`（保留空格和中文，prompt 里用独立行/代码块包路径，别裸贴在句子里） |
| `\\wsl.localhost\Ubuntu\home\foo\proj` | `/home/foo/proj` |
| `\\wsl$\Ubuntu\mnt\d\code` | `/mnt/d/code` |
| 已经是 `/home/...` 或 `/mnt/...` | 原样使用 |
| Windows junction / 符号链接 | 在 WSL 里跑 `wslpath -u "<windows-path>"` 让系统帮你转，比手写靠谱 |

**`dispatch_task.projectPath` 必须是已注册的路径原样**（不要自己拼 `/mnt/...`）：先 `list_projects` 拿到 cc-panes 实际登记的字符串，原样传入，再配 `runtimeKind: "wsl"`。**只有 prompt 文本里的路径**才需要按上表转。

---

## 执行步骤

### Phase 1：完成初版 plan

按常规 plan mode 流程：探索代码、设计方案，按上面"单一路径策略"写到 `.claude/plans/<topic>.md`。记住 `<plan_path>`。

### Phase 1.5：注册 leader（这是 worker 自动反馈的前提）

```
mcp__ccpanes__register_plan_leader(
  planPath: <plan_path 原样 Windows 路径>,
  projectPath: <项目路径，与 list_projects 中一致>,
  cliTool: "claude",
  sessionId: <当前 Claude 自己的 sessionId>,
  title: "Review leader: <plan 简短描述>",
  workspaceName: <workspace 名，可选>
)
```

返回的 `id` 就是 `<leaderId>`，记下来。

**怎么拿自己的 sessionId？** 调 `mcp__ccpanes__list_sessions`，找 `status=thinking` 且 `lastOutputAt` 最新的那条——这就是正在执行工具调用的当前 Claude 实例。**沒有这一步，worker 的 `report_to_leader` 找不到地方写。**

### Phase 2：确认 reviewer 目标

**先自动发现可复用的活 reviewer**（`AskUserQuestion` 之前做，不要等用户报标签名）：

1. `mcp__ccpanes__query_task_bindings(projectPath: <项目路径>, role: "worker")`
2. 客户端过滤：`workerKind === "reviewer"`，且 `status` 非 `completed`/`failed`，且其 `sessionId` 出现在 `mcp__ccpanes__list_sessions` 的活会话里（= isLive）
3. **命中** → 问题 1 的第一选项改为「复用 <该 binding 的 title>（推荐，同主题续审；新主题建议新开）」，并提示用户：旧 reviewer 若不复用，可顺手 `kill_session` 回收
4. **未命中** → 保持下面的三选项原样

用 `AskUserQuestion` 问：

```
问题 1: reviewer 用哪个兼容 CLI、跑在哪？
  - <与当前实例不同的可用 CLI> (WSL 或本地)   ← 跨工具盲点最大，推荐
  - <用户指定的 CLI> (本地或 WSL)
  - 已有窗口（我告诉你标签名）

问题 2: 评审维度有补充吗？
  - 默认 6 维（业务时序 / 数据耦合 / UI 可行性 / 数据红线 / 回滚完整性 / 未覆盖场景）
  - 加：性能 / 安全 / 兼容性 / ...
```

"已有窗口"分支：`mcp__ccpanes__list_sessions` + `mcp__ccpanes__list_panes` 找 sessionId。

### Phase 3：启动 reviewer 并喂上下文

**新建窗口**：

```
mcp__ccpanes__dispatch_task(
  projectPath: <list_projects 取到的已注册路径，WSL 通常是 UNC 形式>,
  cliTool: <用户确认的目标工具>,
  runtimeKind: "wsl",                 // 本地省略
  title: "Reviewer: <plan 简短描述>",
  parentBindingId: <Phase 1.5 拿到的 leaderId>,
  prompt: <见下方 prompt 模板>
)
```

记录返回的 `bindingId` 和 `sessionId`。`dispatch_task` 已在启动前建立 TaskBinding；不要再额外注册 worker。目标会话可以从 `CC_PANES_TASK_BINDING_ID` 读取自己的 binding id。

**已有窗口（复用）**：复用的单元是**会话**，不能重新经过 `dispatch_task` 的启动前持久化；此时才使用 `register_plan_worker` 建兼容 binding（新 plan 就新登记一条，同样带 `workerKind: "reviewer"`）。记录其返回的 `<workerId>`，并在 prompt 中用它替代环境变量：

```
mcp__ccpanes__register_plan_worker(
  leaderId: <Phase 1.5 拿到的>,
  sessionId: <匹配到的>,
  projectPath: <同 leader>,
  cliTool: <复用会话的目标工具>,
  title: "Reviewer: <主题>",
  workerKind: "reviewer"
)

mcp__ccpanes__submit_to_session(
  sessionId: <匹配到的>,
  text: <prompt 模板，不含换行符——submit_to_session 会自动处理回车时序>
)
```

> `submit_to_session` 专门处理 Claude/Codex (ink) 提交时序：先写文本 → 等 150ms → 单独发 Enter。**绝大多数场景用它。** `write_to_session` 只用于发原始字节（如 Ctrl+C = `"\x03"`）。

### Phase 4：等 reviewer 完成

**首选：等 PTY 自动反馈**（前提是 Phase 1.5 + Phase 3 都注册过了）：

worker 调 `report_to_leader` 时，PTY 会直接把一行 `[worker-report] id=... status=completed summary=...` 推到 leader 的对话里——你下一步看见这行就知道完成。**不用主动 poll。** leader busy 时引擎会排队并在你空闲后自动补投（返回 `queued:true`），worker 无需重试。

**兜底：软超时检查**（防止 worker 卡住又没 report）：

```
mcp__ccpanes__get_session_status(<workerSessionId>)
```

`status` 字段实际枚举：

| 类别 | 值 | 含义 |
|------|-----|------|
| 仍在跑 | `active`, `thinking` | 继续等 |
| 需要交互 | `waitingInput` | 评审已写完且回到提示符，结合输出尾部三段式判断是否真完工；或者卡住等用户输入 |
| 终止 | `idle`, `exited` | 进入 Phase 5 |

**软超时节奏**（不强制 kill，给用户选）：

| 时刻 | 动作 |
|------|------|
| T+5min | `get_session_status` 看 `lastOutputAt`：如果还在动（最近 30s 内有输出），继续等 |
| T+10min | 仍没 `report_to_leader` 且 `lastOutputAt` 停了 → `get_session_output(lines: 200)` 抓尾部，`AskUserQuestion` 问用户：「继续等 / 读取部分输出 / 发消息提醒 / `kill_session` 重发」 |
| T+15min | 用户没回应也没新输出 → 同上但默认推荐 kill |

**兜底定时器**：`ScheduleWakeup(delaySeconds: 270, prompt: "check reviewer session <workerSessionId>")` 在 ~4.5 分钟后回来 check 一次，避免烧 5min cache。**`ScheduleWakeup` 是 Claude 内置工具，不是 ccpanes MCP**。

### Phase 5：读 reviewer 输出 + 结构化吸收

```
mcp__ccpanes__get_session_output(<workerSessionId>, lines: 800)
```

输出可能被 ccpanes 的字符上限截断——长评审分两次读（第二次再调一次，缓冲会包含到最新内容）。

把输出按 ✅ / ⚠️ / ❓ 三段分类（reviewer 应按模板输出，没按就你来归类）：

- ✅ **已确认稳妥** — 不动 plan
- ⚠️ **必修问题** — 必须改 plan 才能继续
- ❓ **开放问题** — 需要用户拍板（业务取舍、风险偏好）

### Phase 6：用 AskUserQuestion 让用户拍板（分批！）

**反模式（不要做）**：

- ❌ 看完 reviewer 输出**默默改 plan**，不告诉用户改了哪些条
- ❌ 把 reviewer 全部建议**一股脑塞进 plan**，不分优先级
- ❌ 只追加在 plan 末尾"反馈纪要"，让老错误条目继续留着
- ❌ 把 10 条必修塞进一个 `AskUserQuestion` —— UI 上选项数会爆

**正确做法**：

- 必修问题按 **≤3 条/批** 分组提问，每条三选项「采纳 / 修改后采纳 / 拒绝」
- 或者：列出编号清单，让用户用文本回复「1 采纳, 2 修改, 3 拒绝 ...」（一次性给完更省往返）
- 开放问题单独一组，每条给业务取舍选项 + reviewer 的倾向作参考

每条都拿到明确答复后再进 Phase 7。

### Phase 7：整体重写 plan（不是追加）

用 `Write` **整体重写** `<plan_path>`：

- 吸收所有"采纳"和"修改后采纳"
- 拒绝项在 plan 顶部一个简短"已评审决议"小节记一笔，不让后人重提
- 不要保留老错误条目（"原步骤 3：xxx —— 已废弃"这种留瑕千万别留）

> 如果走的是路径 B（Phase 1 已 ExitPlanMode），此时直接 Write 即可，不要再 EnterPlanMode。

### Phase 8：收尾

- 简短告诉用户："reviewer 提了 N 条必修、M 条开放，已按你的拍板重写 plan"
- **回收 reviewer**：plan 定稿后提示用户是否 `kill_session` 掉 reviewer 会话——留着可同主题续审（上下文摊销），不留就回收，别让 reviewer 尸体挂在协作板上
- 路径 A：让用户看完最新 plan 再决定是否 `ExitPlanMode`
- 路径 B：让用户决定要不要 `EnterPlanMode` 复审一遍
- **不要主动 `ExitPlanMode`/`EnterPlanMode`**——切换由用户掌控

---

## Reviewer Prompt 模板

发给目标 reviewer 的提示词骨架，必须包含自包含的范围与收尾约定：

```
你是独立同行评审者。请审阅以下 plan，不要执行，不要写代码。

## Plan 文件
<plan_path>   （reviewer 跑 WSL 时已转 WSL 路径，独立一行，不要塞在句子里）

## 背景文档
- <业务文档 1 路径>
- <业务文档 2 路径>

## 涉及的代码改动要点
- <文件 1>：<改动一句话>
- <文件 2>：<改动一句话>

## 评审维度（请逐条点名）
1. **业务时序**：步骤先后是否符合真实业务流，有无并发/竞态
2. **数据耦合**：跨表/跨服务的数据依赖是否处理
3. **UI 可行性**：UI 上声称的控件/路径是否真的存在、可点
4. **数据红线**：生产数据、隐私字段、不可逆操作的边界
5. **回滚完整性**：每一步是否有对应回滚，回滚是否能恢复全部状态
6. **未覆盖场景**：异常路径、边界值、权限/角色差异

## 输出格式（严格三段）
✅ 已确认稳妥：<点列，每条 1 行>
⚠️ 必修问题：<点列，每条标维度 + 具体位置 + 修改建议>
❓ 开放问题：<点列，每条标维度 + 选项 + 你的倾向>

不要复述 plan 内容，不要泛泛而谈，只列具体可执行的修改点。

## 收尾要求（必须执行，测试目标）
若当前会话可使用 ccpanes MCP，评审写完后先调用：
mcp__ccpanes__update_task_binding(
  id: <新派发时为 CC_PANES_TASK_BINDING_ID；复用时为 workerId>,
  status: "completed",
  progress: 100,
  completionSummary: "评审完成,必修 N 条/开放 M 条,详见 PTY 输出"
)

再调用：
mcp__ccpanes__report_to_leader(
  workerId: <新派发时为 CC_PANES_TASK_BINDING_ID；复用时为 workerId>,
  status: "completed",
  summary: "评审完成,必修 N 条/开放 M 条,详见 PTY 输出"
)
如果返回 {sent: false, queued: true} 不用重试——引擎会在 leader 空闲后自动补投。
如果没有 ccpanes MCP 或调用失败，把完整评审结论、验证范围和错误信息打印到终端。
```

替换 `<plan_path>` 和文档路径时**记得 WSL 路径转换 + 独立行包路径**（reviewer 跑 WSL 时）。新派发的 worker 从环境读取 binding id；只有复用会话时才必须在发 prompt 前把 `<workerId>` 写死。

---

## 关键工具调用速查

**ccpanes MCP 工具**（操作 cc-panes 实例）：

| 步骤 | 工具 |
|------|------|
| 查项目是否注册 | `mcp__ccpanes__list_projects` |
| 注册项目 | `mcp__ccpanes__add_project_to_workspace(workspaceName, projectPath)` |
| 注册 leader | `mcp__ccpanes__register_plan_leader` |
| 发现可复用 reviewer | `mcp__ccpanes__query_task_bindings(projectPath, role: "worker")` → 过滤 `workerKind === "reviewer"` |
| 找已有窗口 | `mcp__ccpanes__list_sessions` + `mcp__ccpanes__list_panes` |
| 启动新 reviewer 窗口 | `mcp__ccpanes__dispatch_task(parentBindingId=leaderId)` |
| 读取派发状态 | `mcp__ccpanes__get_task_dispatch(bindingId)` |
| 复用已有窗口提交 | `mcp__ccpanes__submit_to_session`（自动回车时序） |
| 发原始字节 / Ctrl+C | `mcp__ccpanes__write_to_session`（`"\x03"`）|
| 查状态 | `mcp__ccpanes__get_session_status` |
| 读输出 | `mcp__ccpanes__get_session_output` |
| worker 上报（目标支持 MCP 时） | `mcp__ccpanes__update_task_binding` 后 `mcp__ccpanes__report_to_leader` |

**Claude 内置工具**（编排/交互）：

| 步骤 | 工具 |
|------|------|
| 选 reviewer / 拍板 | `AskUserQuestion`（必修分批，≤3 条/次） |
| 延后回来 check | `ScheduleWakeup`（delay 270s 起步，避开 5min cache 失效） |
| 写 plan | `Write`（整体重写，非追加） |

---

## 与 plantocodex 的区别

| 维度 | plantocodex | planreview |
|------|-------------|------------|
| 目的 | 把 plan 交给 Codex **执行** | 把 plan 交给兼容 CLI **评审** |
| 目标角色 | Codex 实现者 | 独立审查者 |
| 是否改代码 | 改 | 不改 |
| 绑定机制 | leader + worker | leader + worker |
| 完成通知 | worker `report_to_leader` PTY 回推 | 同上 |
| Plan 后续 | Codex 直接改代码 | 当前 leader 重写 plan |
| 是否需要用户拍板 | 否（执行类） | 是（评审条目逐条拍板） |
| 退出 plan mode | Codex 启动前 | 评审吸收完之后（或路径 B 时第一次写 plan 时） |

**串联**：先 `planreview` 评审 → 用户拍板 → 重写 plan → 用户决定 `ExitPlanMode` → `dispatch-task` 或 `plantocodex` 接同一个 `<plan_path>` 派实现者执行（WSL Codex 细节见 `plan2codexwsl`）。

---

## 反模式总结

- ❌ 默默吸收 reviewer 反馈，不让用户拍板
- ❌ 在 plan 末尾追加而不是整体重写
- ❌ reviewer 还没输出三段式就强行总结
- ❌ 给 reviewer 喂 Windows 路径却让它跑在 WSL 里
- ❌ 把 reviewer 当实现者用——让它去改代码（这是 dispatch-task / plantocodex 的事）
- ❌ 跳过 `register_plan_leader` / `dispatch_task(parentBindingId=leaderId)` —— 新派发任务没有持久化父关系，无法可靠追踪或回报
- ❌ 跳过软超时 —— reviewer 卡死时用户体验为零
- ❌ 把 10 条必修塞进一个 `AskUserQuestion` —— UI 选项数爆掉
- ❌ 反复 `ExitPlanMode → EnterPlanMode` —— 单一路径走完
- ❌ 让复用会话自己猜 workerId —— 只有复用分支需要 leader 在 prompt 里给死；新派发会话使用环境变量

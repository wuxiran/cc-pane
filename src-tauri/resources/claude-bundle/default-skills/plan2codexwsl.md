---
name: ccpanes-plan2codexwsl
description: 在 plan mode 内启动另一个 Codex CLI（WSL 或本地）对 plan 做同行评审。leader/worker 自动反馈，软超时兜底，AskUserQuestion 让用户拍板，再整体重写 plan。专治"同一个 Claude 我审我"的盲区。
trigger: |
  - 用户在 plan mode 里写完初版 plan，想找另一个 CLI 做同行评审 / 交叉审 / peer review
  - 用户明说"找 codex 评审 plan"、"开个 WSL Codex 审一下"、"在另一个窗口审 plan"
  - 用户提到 UI E2E 测试计划、数据迁移/回滚计划、上线变更计划这类高风险 plan 需要二审
  不触发：trivial plan（< 30 行、纯代码 refactor）、用户已明说不要双 CLI、Codex CLI 未安装
---

# plan2codexwsl — 跨 CLI Plan 同行评审

你是 Plan 同行评审编排 Agent。Claude 自己写完 plan 后启动另一个 Codex 实例（WSL 优先）独立审 plan，**通过 cc-panes 的 leader/worker 机制让 worker 自动 PTY 反馈完成事件**，把结构化反馈拿回来，由用户分批拍板后整体重写 plan。

> 单一 Claude 审自己写的 plan 容易有"我审我"盲区。换一个 CLI 实例读同一份 plan + 同一份代码，能挖出操作错误假设、UI 不可达控件、数据耦合、回滚遗漏等盲点。

> **当前只支持 Codex CLI**。`launch_task` 的 `cliTool` 只接受 `claude` / `codex`，Gemini/Cursor 暂不可用（要走"已有窗口"分支手工提交）。

---

## 何时用 / 何时不用

**用**：

- Plan 涉及 **UI 端到端测试** / **数据迁移与回滚** / **跨服务时序** / **线上变更**
- Plan 文件 ≥ 50 行，含多阶段步骤、SQL、回滚脚本、兜底逻辑
- 用户提到"想找 codex 审一下"、"换个角度看"、"再 review 一遍"
- 风险高、改错代价大、用户希望留下可审计的 reviewer 对话窗口

**不用**：

- 纯代码 refactor、单文件改动、< 30 行 plan
- 用户明说"我自己看就行 / 不要再叫 codex"
- Codex CLI 未安装，且用户不愿换工具
- 已经走完一轮评审、用户在二轮迭代（这种直接改 plan，不重复启 reviewer）

---

## 前置检查（开干前都要过）

1. **当前在 plan mode 吗？** 否则提醒用户先 `EnterPlanMode`，写完初版 plan 再回来
2. **能写 plan 文件吗？** — 见下方"plan mode 与 Write 的单一路径策略"
3. **目标 reviewer 走本地还是 WSL？** 直接 `AskUserQuestion` 问用户（不要靠 `list_launch_history` 猜——历史可能为空或含已废弃会话）
4. **ccpanes 已注册当前项目？** 调 `mcp__ccpanes__list_projects`，**WSL 启动必须用其中已注册的项目路径**（UNC `\\wsl.localhost\Ubuntu\...` 或 `/mnt/...` 都可能存在，挑已注册那条）。缺则提示用户先 `add_project_to_workspace(workspaceName, projectPath)`

### plan mode 与 Write 的单一路径策略

不要反复 `ExitPlanMode → Write → EnterPlanMode`，每次切换都打断用户。按这个**单一顺序**走：

- **路径 A（首选）**：项目 hook 已放行 `.claude/plans/` 写入 → 直接 `Write` 到 `.claude/plans/<topic>.md`，**整个流程都在 plan mode 内完成**。
- **路径 B（hook 没放行时）**：第一次写 plan 就 `ExitPlanMode` 拿用户授权，**之后整个评审 + 重写都在 plan mode 外完成**；最后用户自己决定要不要再 `EnterPlanMode` 复审。**不要再 EnterPlanMode 回到 plan mode 然后又被 Write 拦**。

试一次 `Write` 即可探出当前在哪条路径。记下 `<plan_path>` 作绝对路径，后续所有调用都用它。

### WSL 路径转换规则

| 输入 | 转换后（喂给 WSL CLI 的 prompt 文本） |
|------|----------------------|
| `C:\Users\foo\.claude\plans\x.md` | `/mnt/c/Users/foo/.claude/plans/x.md` |
| `D:\code\erp\docs\spec.md` | `/mnt/d/code/erp/docs/spec.md`（盘符全部小写） |
| `D:\路径 含空格\plan.md` | `/mnt/d/路径 含空格/plan.md`（保留空格和中文，prompt 里用独立行/代码块包路径，别裸贴在句子里） |
| `\\wsl.localhost\Ubuntu\home\foo\proj` | `/home/foo/proj` |
| `\\wsl$\Ubuntu\mnt\d\code` | `/mnt/d/code` |
| 已经是 `/home/...` 或 `/mnt/...` | 原样使用 |
| Windows junction / 符号链接 | 在 WSL 里跑 `wslpath -u "<windows-path>"` 让系统帮你转，比手写靠谱 |

**`launch_task.projectPath` 必须是已注册的路径原样**（不要自己拼 `/mnt/...`）：先 `list_projects` 拿到 cc-panes 实际登记的字符串，原样传入，再配 `runtimeKind: "wsl"`。**只有 prompt 文本里的路径**才需要按上表转。

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

用 `AskUserQuestion` 问：

```
问题 1: Codex reviewer 跑在哪？
  - Codex (WSL)   ← 跨工具盲点最大，推荐
  - Codex (本地)
  - 已有窗口（我告诉你标签名）

问题 2: 评审维度有补充吗？
  - 默认 6 维（业务时序 / 数据耦合 / UI 可行性 / 数据红线 / 回滚完整性 / 未覆盖场景）
  - 加：性能 / 安全 / 兼容性 / ...
```

"已有窗口"分支：`mcp__ccpanes__list_sessions` + `mcp__ccpanes__list_panes` 找 sessionId。

### Phase 3：启动 reviewer 并喂上下文

**新建窗口**（推荐 Codex WSL）：

```
mcp__ccpanes__launch_task(
  projectPath: <list_projects 取到的已注册路径，WSL 通常是 UNC 形式>,
  cliTool: "codex",
  runtimeKind: "wsl",                 // 本地省略
  title: "Reviewer: <plan 简短描述>",
  prompt: <见下方 prompt 模板>
)
```

记录返回的 `sessionId` 作为 `<workerSessionId>`。

**立即注册 worker**（leader 来做，比让 Codex 自己注册更稳）：

```
mcp__ccpanes__register_plan_worker(
  leaderId: <Phase 1.5 拿到的>,
  sessionId: <workerSessionId>,
  projectPath: <同 launch_task>,
  cliTool: "codex",
  title: "Reviewer worker"
)
```

返回的 `id` 是 `<workerId>`，**必须把它写进 prompt 模板的"收尾要求"那一段**，让 Codex 完成时调 `report_to_leader(workerId=...)`。

**已有窗口**：

```
mcp__ccpanes__submit_to_session(
  sessionId: <匹配到的>,
  text: <prompt 模板，不含换行符——submit_to_session 会自动处理回车时序>
)
```

> `submit_to_session` 专门处理 Claude/Codex (ink) 提交时序：先写文本 → 等 150ms → 单独发 Enter。**绝大多数场景用它。** `write_to_session` 只用于发原始字节（如 Ctrl+C = `"\x03"`）。

### Phase 4：等 reviewer 完成

**首选：等 PTY 自动反馈**（前提是 Phase 1.5 + Phase 3 都注册过了）：

worker 调 `report_to_leader` 时，PTY 会直接把一行 `[worker-report] id=... status=completed summary=...` 推到 leader 的对话里——你下一步看见这行就知道完成。**不用主动 poll。**

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

**兜底定时器**：用 `CronCreate`（`recurring: false`，一次性提醒）设一个几分钟后回来 check 的提醒，例如 `prompt: "check reviewer session <workerSessionId>"`，避免空等；或更简单地用后台 Bash 计时器（`run_in_background` 跑 `sleep 270 && echo poll`，到点被通知后再 `get_session_status` / `get_session_output`）。**`CronCreate` 是 Claude 内置工具，不是 ccpanes MCP**。

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
- 路径 A：让用户看完最新 plan 再决定是否 `ExitPlanMode`
- 路径 B：让用户决定要不要 `EnterPlanMode` 复审一遍
- **不要主动 `ExitPlanMode`/`EnterPlanMode`**——切换由用户掌控

---

## Reviewer Prompt 模板

发给 Codex 的提示词骨架，**必须**包含 worker 注册参数和收尾上报指令：

```
你是独立同行评审者。请审阅以下 plan，不要执行，不要写代码。

## Plan 文件
<plan_path>   （已转 WSL 路径，独立一行，不要塞在句子里）

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
评审写完后立刻调用：
mcp__ccpanes__report_to_leader(
  workerId: "<把 Phase 3 拿到的 workerId 原样填进来>",
  status: "completed",
  summary: "评审完成,必修 N 条/开放 M 条,详见 PTY 输出"
)
如果调用失败，把错误信息打印到终端。
```

替换 `<plan_path>` 和文档路径时**记得 WSL 路径转换 + 独立行包路径**。`<workerId>` 必须在发 prompt 前就解析好——Codex 不应该自己去猜。

---

## 关键工具调用速查

**ccpanes MCP 工具**（操作 cc-panes 实例）：

| 步骤 | 工具 |
|------|------|
| 查项目是否注册 | `mcp__ccpanes__list_projects` |
| 注册项目 | `mcp__ccpanes__add_project_to_workspace(workspaceName, projectPath)` |
| 注册 leader | `mcp__ccpanes__register_plan_leader` |
| 找已有窗口 | `mcp__ccpanes__list_sessions` + `mcp__ccpanes__list_panes` |
| 启动新 reviewer 窗口 | `mcp__ccpanes__launch_task` |
| 注册 worker | `mcp__ccpanes__register_plan_worker` |
| 复用已有窗口提交 | `mcp__ccpanes__submit_to_session`（自动回车时序） |
| 发原始字节 / Ctrl+C | `mcp__ccpanes__write_to_session`（`"\x03"`）|
| 查状态 | `mcp__ccpanes__get_session_status` |
| 读输出 | `mcp__ccpanes__get_session_output` |
| worker 上报（在 reviewer prompt 里要求 Codex 自己调） | `mcp__ccpanes__report_to_leader` |

**Claude 内置工具**（编排/交互）：

| 步骤 | 工具 |
|------|------|
| 选 reviewer / 拍板 | `AskUserQuestion`（必修分批，≤3 条/次） |
| 延后回来 check | `CronCreate`（`recurring: false` 一次性提醒）或后台 Bash `sleep` 计时器 |
| 写 plan | `Write`（整体重写，非追加） |

---

## 与 plantocodex 的区别

| 维度 | plantocodex | plan2codexwsl |
|------|-------------|----------------|
| 目的 | 把 plan 交给 Codex **执行** | 把 plan 交给 Codex **评审** |
| Codex 角色 | 实现者 | 独立审查者 |
| 是否改代码 | 改 | 不改 |
| 绑定机制 | leader + worker | leader + worker（本 skill v2 起对齐） |
| 完成通知 | worker `report_to_leader` PTY 回推 | 同上 |
| Plan 后续 | Codex 直接改代码 | Claude 自己重写 plan |
| 是否需要用户拍板 | 否（执行类） | 是（评审条目逐条拍板） |
| 退出 plan mode | Codex 启动前 | 评审吸收完之后（或路径 B 时第一次写 plan 时） |

**串联**：先 `plan2codexwsl` 评审 → 用户拍板 → 重写 plan → 用户决定 `ExitPlanMode` → `plantocodex` 接同一个 `<plan_path>` 派 Codex 实现。

---

## 反模式总结

- ❌ 默默吸收 reviewer 反馈，不让用户拍板
- ❌ 在 plan 末尾追加而不是整体重写
- ❌ reviewer 还没输出三段式就强行总结
- ❌ 给 reviewer 喂 Windows 路径却让它跑在 WSL 里
- ❌ 把 reviewer 当 Codex 用——让它去改代码（这是 plantocodex 的事）
- ❌ 跳过 `register_plan_leader` / `register_plan_worker` —— 没这两步，`report_to_leader` 推不到你这边，等于没自动反馈
- ❌ 跳过软超时 —— reviewer 卡死时用户体验为零
- ❌ 把 10 条必修塞进一个 `AskUserQuestion` —— UI 选项数爆掉
- ❌ 反复 `ExitPlanMode → EnterPlanMode` —— 单一路径走完
- ❌ 让 Codex 自己猜 sessionId / workerId —— leader 在 prompt 里给死

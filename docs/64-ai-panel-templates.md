# 64 · AI 面板模板化与编排拓扑视图

> 方向性文档。按项目惯例，方向文档不整体预审；实施时逐条抽成独立 plan 再做交叉评审。
> 目标版本：0.11.3 之后（当前发布候选的阻断项优先）。

## 症状

AI 面板的双向通道**早就建好了**，但几乎没人能用对。

`AiPanelFrame.tsx:110-120` 有一条完整的 bridge：sandboxed iframe（`sandbox="allow-scripts"`，origin 锁 `"null"`）里 `postMessage` 出来，经 `isBridgeMessage` 校验（action 正则 + payload 字节上限），落到 `aiPanelService.recordEvent`，调用方用 `get_ai_panel_events` 取回。也就是说 AI 面板不是只读展示板，**它是一个可以收用户输入的 UI**。

但 `open_ai_panel(title, format, content)` 里的 `content` 是 **AI 手写的整块 HTML**。每弹一次面板，模型都要现场产出：

- 一整套 CSS——而它不知道 `var(--app-text-tertiary)` 这些 token，所以面板的配色永远和主题对不上，看着像一个嵌进来的网页而不是 app 的一部分；
- 一段 bridge JS——`postMessage({type, bridgeId, action, payload})` 的精确形状。**手写的桥接代码正是那种会静默写错的东西**：按钮点了没反应，用户以为卡了，AI 那头 `get_ai_panel_events` 读到空也不知道是「用户还没点」还是「桥断了」，两者完全同形；
- 布局、按钮、状态色——每次重新发明，面板之间毫无一致性。

## 根因

**面板的契约停在「传一段任意文档」，而实际需求是「渲染一个有类型的交互组件」。**

`content: String` 这个签名把三件本该分离的事压成了一件：数据（要展示什么）、呈现（长什么样）、协议（怎么把用户操作送回去）。呈现和协议对每一类面板都是固定的，却被迫由模型每次重新生成——这既是最大的 token 浪费，也是唯一的可靠性缺口。

## 方案

### 1. MCP 面：加参数，不加工具

工具面已有 88 个，不该为此再涨。给 `open_ai_panel` 加一对可选参数，与现有路径并存：

```
open_ai_panel(templateId: "choice", data: { ... })   // 模板路径
open_ai_panel(format: "html", content: "...")        // 保留，逃生阀
```

外加**一个** `list_ai_panel_templates` 供发现，返回 `{ id, description, dataSchema }`。

每个模板声明自己的 data JSON Schema，**在边界校验**（符合「输入验证在系统边界」）。AI 填错时当场返回结构化错误，而不是弹出一个坏面板——今天 AI 写错 HTML 是没有任何反馈的。

### 2. 渲染：内置模板走原生 React，用户模板留 iframe

两条路并存：

| | 内置模板 | 用户模板 |
|---|---|---|
| 载体 | 原生 React 组件 | iframe（现有 bridge 不变） |
| 主题 | 直接用 app CSS token / shadcn | 需注入，一致性打折 |
| 扩展 | 随 app 发版 | 工作空间级 `.ccpanes/panels/` |
| 隔离 | 无（是 app 自己的代码） | sandbox 保持 |

内置那批走原生是**核心动机**——「面板长得像 app 的一部分」这件事 iframe 会一直拖后腿。iframe 那条保留扩展性和隔离，不删。

### 3. 首批模板

按「今天没有好 UI」的痛感排序，前两个是**场景根本不存在 UI**，不是「有但难看」：

| 模板 | 使用方 | 今天的状况 |
|---|---|---|
| `fleet` | plantocodex / parallel 的 leader | leader 盯 N 个 worker 全靠 `get_session_output` 刷文字 |
| `comparison` | fanout-compare | N 份实现挑赢家，纯靠人翻 N 个 worktree |
| `choice` | planreview、所有需用户拍板处 | AskUserQuestion 塞不下 diff/预览，只能扔终端里让人读 |
| `diff` | 代码型 worker 收尾 | —— |
| `report` | finish-work | 一坨 markdown |
| `form` | 派工前收参数 | 一问一答来回好几轮 |

---

## fleet：编排拓扑视图

### 4. 树已经在数据里了

`TaskBinding`（`cc-panes-core/src/models/task_binding.rs`）现状：

```rust
pub role: TaskBindingRole,        // Task | Leader | Worker
pub parent_id: Option<String>,
pub status: TaskBindingStatus,    // Pending | Running | Waiting | Completed | Failed
pub progress: i32,
pub metadata: Option<serde_json::Value>,
```

`parent_id` 是无条件的 `Option`，不是「只有 worker 才有」——**模型可表达 leader 挂 leader**：一个 `role: Leader` 的节点自己带 `parent_id` 指向上级 leader，数据结构层面不需要改。

> **但登记不变式尚未实现**（Codex 评审纠正，此前本节曾误称「已经免费成立」）：
> `register_plan_leader` 固定写 `parent_id: None`，worker 登记固定 `role: Worker`，
> 服务层与 DB 都**没有**父存在性校验、父角色校验、同 plan 校验、无环校验。
> 所以多层编排要落地，需要新增一条受控的嵌套 leader 登记路径，并在
> `task_binding_service.rs` 的服务边界补齐上述四项不变式。字段形状允许 ≠ 能用。

### 5. 「循环」是时间维度，不是拓扑——不要建图

leader 派活 → worker 报告 → leader 复审 → 再派：这个循环从头到尾走的是**同一条 leader↔worker 边**，只是走了 N 次。

表达它需要的是**边上的轮次计数与上次回报时间**，不是新的图结构。

若为此把 `parent_id` 换成边表，代价是：多父语义歧义、环检测、`TaskBindingService` 整套不变式重写、数据迁移。换来的表达力，一个边标签就能覆盖。

> **唯一真正需要边表的场景**是 worker→worker 横向交接（fanout-compare 赢家合并、A 的产物喂给 B）。**先不做**；真出现这个工作流时，它是一张独立的「产物流转」边，不该和汇报关系混进同一张图。

### 6. 节点：状态色之外必须有静默时长

**节点上绝对不能只显示 `status`。**

CLAUDE.md 已记录的暗雷：

> 派出去的 WSL Codex worker 可能"活着但一动不动"，判活不能只看 `status`。进程活着、cwd/YOLO 都对，但 PTY 零输出、`lastOutputAt` 永远停在派发那一刻——与"刚启动还没输出"**完全同形**。

一个只画「Running 绿点」的节点，会用**和今天的 `status` 一模一样的方式撒谎**，而且因为图形看起来更权威，骗得更狠。

所以 `lastOutputAt` 至今的静默时长必须是与状态**并列的第一等视觉通道**，不是 tooltip 里的小字。Running 但 12 分钟无输出的 worker，与 Running 且 5 秒前刚吐字的 worker，必须一眼可分。

节点面：

| 通道 | 内容 | 理由 |
|---|---|---|
| 状态色 | status 五态 | 按 docs/46 状态色映射，waiting 走琥珀约定 |
| **静默时长** | `lastOutputAt` 至今 | 防假活，见上 |
| 功能身份 | reviewer / implementer / … | 见 §7 |
| 运行身份 | cliTool × runtimeKind × launchId | 防串台，见 §7 |
| 位置 | project / worktree | worktree 隔离是常态 |
| 进度 | progress + completionSummary | 已有 |

### 7. 身份分两层，且运行身份有现成缺口

**功能身份**（reviewer / implementer / tester）——派工时声明的语义标签。值得给 `TaskBinding` 加真字段：可查询、能驱动派发路由（「把这活给 reviewer」）。不塞 `metadata`。

**运行身份**（哪个 CLI、哪个 runtime、哪个 launchId）——派生。这里有个独立于画布的**现成缺口**：`TaskBinding` 有 `cli_tool: String`，但**没有 `runtime_kind`**——今天从 binding 上看不出这个 worker 跑在本地还是 WSL。

结合 CLAUDE.md 最凶的那条：

> agent 可能整场都在驱动另一个实例（dev/release 串台），且完全无法自察。自查方法：`$CC_PANES_LAUNCH_ID` 必须等于所连 MCP URL 里的 `launchId`，不等即串台。

把每个节点的 launchId 归属画出来，**串台会变成一眼可见的图形事实**——有个节点孤零零挂在另一棵树上。这大概是这张图除「看进度」之外最大的实际价值。

> `runtime_kind` 缺失是独立可跟踪条目，与本模板无关也该补；它今天就在让串台排查变难。

### 8. 自动布局的有向图，不是自由无限画布

图是**从数据派生的**：树结构 + 自动布局（dagre/elk 对树近乎零成本），永远自洽、自愈、零迁移。

自由画布意味着用户手摆节点，随之而来的是位置持久化、碰撞、视口状态、新节点插哪儿——为一张派生图付这些成本不划算。

这与 docs/62 刚验证过的原则一致：

> worktree 归属：运行时派生，不加持久化字段。关系永远等于 git 真相、自愈、零迁移成本。

**节点坐标是视图状态，不是领域模型。** 真要支持手动摆放，也应是独立 view-state 表按 binding id 存，绝不进 `TaskBinding`。

画布值得投入的不是「能拖」，是**能操作**：点节点看输出、右键 `write_to_session` 发裸 CR 捅醒卡住的 worker（正是 §6 那条暗雷的标准解法，**不要 kill 重发**）、直接 kill、直接派新活。从看板变成控制面，才配得上这个工程量。

### 9. fleet 的数据源与其他模板相反

其他模板（choice / diff / report）是 **AI 填 data**。

fleet **不是**——数据源是 app 自己读一手真相，AI 只说「打开 fleet 面板，范围是 plan X」。

区别很大：AI 填数据会带来一整类「AI 报的状态与实际不符」的 bug，而 fleet 恰恰是最不能撒谎的面板。

### 9.1 但「读 task_bindings」不够——需要聚合契约

> Codex 评审纠正。此前本节写的是「实时读 `task_bindings`」，**不成立**。

节点面上承诺的字段分散在四个来源，`TaskBinding` 只占其一：

| 字段 | 实际来源 | 说明 |
|---|---|---|
| role / parentId / status / progress | `TaskBinding` | 有 |
| **lastOutputAt（静默时长）** | `terminal_service.rs` 的 SessionStatus | **不在 binding 上** |
| **runtimeKind / launchId** | 终端会话或启动历史 | **不在 binding 上**（§7 的缺口） |
| **输出直方图（活动轨迹）** | 无任何来源 | **需新增有界活动桶** |
| 派工轮次 / 上次回报 | 无 | 只留最新 `completion_summary`，取不到轮次 |

两个必须记住的坑：

1. **`createdAt` 是 binding 年龄，不是进程年龄。** resume / relaunch 之后两者分叉——
   而「基线长度 = 存活时长」这个消解同形的关键（§6）恰好依赖进程年龄，用错就白做。
2. **活动直方图无法从单个 `lastOutputAt` 反推。** 它是一条时间序列，
   必须落一个有界的活动桶或事件流；想省这一步就等于放弃 §6 的整个可视化。

因此实施前的第一步不是画 UI，是**定义 app 侧的 `FleetNodeSnapshot` 聚合契约**：
明确 `TaskBinding + SessionStatus + launch provenance + activity history` 的合并规则，
以及每个字段的**缺失态**（旧 daemon / 已退出会话 / 未启动任务都会缺）。
按既有原则——服务端新增字段必须可缺失——缺失应降级呈现并可见，不得当成 0 或正常。

---

## 关键文件

| 文件 | 角色 |
|---|---|
| `web/components/aipanel/AiPanelFrame.tsx` | 现有 iframe bridge（`isBridgeMessage` / `recordEvent`） |
| `web/types/aiPanel.ts` | `AiPanelFormat` / `AiPanelDisplay` / `AiPanelDelivery` |
| `src-tauri/src/services/orchestrator_service.rs` | `open_ai_panel` / `update_ai_panel` / `get_ai_panel_events` |
| `cc-panes-core/src/models/ai_panel.rs` | 面板领域模型 |
| `cc-panes-core/src/repository/ai_panel_repo.rs` | 面板历史持久化 |
| `cc-panes-core/src/models/task_binding.rs` | fleet 的数据源；`runtime_kind` 缺口在此 |
| `cc-panes-core/src/services/task_binding_service.rs` | 不变式所在，加字段须过这里 |

## 遗留 / 待定

- **worker→worker 边表**：暂不做，等真实工作流出现（§5）。
- **手动摆放节点**：暂不做；若做，独立 view-state 表（§8）。
- **`runtime_kind` 字段**：独立条目，可先于本文档实施（§7）。
- **功能身份字段**：需定枚举还是自由字符串——自由字符串更适合 AI 派工的开放语义，但失去校验；未定。
- **模板版本化**：内置模板随 app 走，但旧实例/旧 daemon 可能不认识新 `templateId`。按既有原则——**服务端新增字段必须可缺失**——未知 templateId 应降级为可读的降级呈现并打印警告，而非报错。

# 18. Skill 体系：把玩法预置进 AI 的脑子

> 你在这本手册里学到的那些玩法——并行派工、Plan 交给 Codex、同行评审、批量分派 Todo——AI 自己是不知道怎么做的。
> **Skill 就是把这些流程写成一份说明书，随 CC-Panes 装进 CLI 里**，于是你只要说一句"并行跑一下"，AI 就照着完整流程走，不用你每次现教。

## 先分清两件事

这一点不分清，后面全乱：

- **Skill 机制是 Claude Code / Codex 自己的**。它们各自会去固定目录扫一批 Markdown 文件当作可调用的流程说明，这跟 CC-Panes 没关系。
- **CC-Panes 做的是"往那些目录里放东西"**：把自己封装好的一批玩法，在应用启动时**自动发布**到各 CLI 的用户目录里，顺带提供一个界面让你管理来自其他地方的 skill。

所以下面讲的"CC-Panes 内置 skill"，本质是 CC-Panes 替你写好、替你安装的一批说明书。

## 四种来源

打开**资源中心 → Skills** 这一页，你会看到正好四段，对应四种来源：

| 段 | 来自哪 | 你能做什么 |
| --- | --- | --- |
| **已安装 Skills** | Skill 市场装到本机用户库的 | 删除 |
| **Skill 市场** | CC-Panes 官方索引 | 一键安装（带 sha256 校验） |
| **外部发现（只读）** | `~/.claude`、`~/.codex`、以及各 plugin 里已有的 | 只能看，不能改 |
| **内置 CC-Panes Skills（只读）** | 随 CC-Panes 一起发布的那批 | 只能看，随版本更新 |

<!-- TODO(img): 资源中心 Skills 页的四段结构，每段标题右边带计数徽标 -->

打开方式：左侧活动栏的**资源中心**图标 → 顶部切到 **Skills** 标签。

> 市场索引拉不到（离线、网络受限）时这一段会是空的，不影响已装的 skill 正常工作。

## CC-Panes 内置了哪些

当前版本内置 26 个，按用途分大致是这几组：

**启动与会话**
- `launch-task` — 启动 Claude/Codex 任务的完整流程（WSL、resume、worktree 路由、卡住时怎么救）
- `clean-launch` — 干净地起项目的 dev/build 进程，自动处理端口和 PID 冲突，记住上次怎么起的
- `fork-session` — 带着当前对话的上下文摘要，另开一个实例走分叉方向
- `browse-sessions` — 查看别的实例在跑什么、读它的输出、翻启动历史

**并行与编排**
- `parallel-run` — 把大任务拆成互相独立的子任务，开多个实例同时跑再汇总
- `parallel-advanced` — 同一个项目内的并行：只读研究走子 agent，改代码的走 worktree 隔离
- `guided-team` — 指挥 / 队长 / 工人的多角色协作
- `dispatch-todos` — 把待办列表批量分发给新实例

**Plan 交接与评审**
- `plantocodex` — Claude 规划、Codex 实现的交接流程
- `plantocc` — 同上，但把活派给另一个 Claude Code 实例
- `plantogrok` — 同上，但派给 Grok CLI（第三方模型视角、原生 worktree）
- `planreview` — 另开一个 CLI 对你的 plan 做同行评审，专治"自己审自己"
- `plan2codexwsl` — plantocodex 的 WSL 特化版（路径转换、runtimeKind）

**工作空间维护**
- `workspace` — 工作空间的增删查、加项目、扫目录批量导入
- `workspace-diagnostics` — 只读诊断：存储、配置文件、数据目录路由
- `organize-workspace` — 整理工作空间目录，先出可审阅的计划，拿不准的只挪进 `_trash/` 不删
- `workspace-migrate` — 引导你走内置的"迁移工作空间"流程（本地换目录 / 本地转 WSL）

**规格与收尾**
- `spec` — 需求 → 设计 → 任务 → 实现的规格驱动流程（需要外部 `spec-workflow` MCP）
- `built-in-spec` — CC-Panes 自带的 Spec + Todo 双向绑定
- `openspec` — 实现前先写 Proposal / Design / Tasks 的方法论
- `finish-work` — 交接前的收尾：看 diff、跑检查、核对文档与测试、写总结
- `cross-layer-check` — 跨层改动（UI / store / IPC / 后端 / 存储）的一致性审查

**记忆与清理**
- `memory-dual-write` — 把长期记忆同时写进 CC-Panes 共享记忆池，让 Claude 和 Codex 看到同一份
- `recall` — 召回当前项目/工作空间的历史 plan
- `cleanup-processes` — 诊断并安全清理僵尸开发进程

## 怎么调用

**最省事的办法：什么都不做，直接用大白话说。**

这些 skill 的说明书里都写了"什么时候该用我"——比如 `parallel-run` 写了「用户说'并行跑'、'同时在多个项目'、'fan out' 时使用」。所以你直接说：

> "这三件事互相独立，并行跑了，完成后汇总给我。"

AI 会自己认出该走哪个 skill。**这是设计意图，也是推荐用法。**

**要显式点名也可以：**

- 在 **Claude** 里：斜杠命令，前缀是 `ccpanes:`——`/ccpanes:launch-task`、`/ccpanes:planreview`。
- 在 **Codex** 里：skill 名带连字符前缀——`ccpanes-launch-task`。

两边名字不同是因为落盘位置不同：Claude 那份放在 `~/.claude/commands/ccpanes/<名字>.md`（子目录变成命名空间前缀），Codex 那份放在 `~/.codex/skills/ccpanes-<名字>/SKILL.md`。

> 这些文件是 CC-Panes 在启动时按当前版本号自动写入并保持更新的，你不用手动装、也不用手动升级。想彻底清掉它们，见 [附录 A](appendix-a-data-and-troubleshooting.md) 里的卸载清理清单。

## 项目级 vs 用户级：三层作用域

| 层 | 存在哪 | 影响范围 | 谁来维护 |
| --- | --- | --- | --- |
| **CC-Panes 内置** | 各 CLI 的用户目录（`ccpanes` 命名空间下） | 这台机器上所有会话 | CC-Panes 自动发布 |
| **用户级** | `~/.cc-panes/skills/user/`（市场装的）；`~/.claude`、`~/.codex`（各 CLI 自己的） | 这台机器上所有会话 | 你（市场安装 / 手写） |
| **项目级** | 项目目录下的 `.claude/commands/*.md` | 只在这个项目里可见 | 你 |

项目级 skill 的文件名就是命令名——`.claude/commands/review.md` 对应 `/review`。它跟着仓库走，所以**适合放"这个项目特有的规矩"**：本项目的提交前检查清单、本项目的发版流程、本项目那套奇怪的构建命令。

## 怎么自己加一个

### 项目级：用内置的 Skill 管理器

1. 打开**资源中心 → Provider** 标签，它默认落在**运行配置**列表上（旁边那个是「Provider 凭证」）。
2. 编辑任意一个运行配置，往下找到 **Skill** 这一段。
3. 拉到 **「工作空间项目 Skill」** 小节，对着目标项目点 **「新增 / 编辑」**。
4. 主区会打开一个 **Skill 管理器**标签页：左边是这个项目现有的 skill 列表（显示成 `/名字`），右上角 `+` 新建，右边是编辑器。
5. 写完保存，文件就落到项目的 `.claude/commands/<名字>.md`。

也可以完全不用界面——**直接在项目里手写那个 `.md` 文件**，效果一样，Skill 管理器只是个方便的编辑入口。

<!-- TODO(img): Skill 管理器标签页——左侧 /命令名 列表，右侧 Markdown 编辑器 -->

### 用户级：从市场装

资源中心 → Skills → **Skill 市场**段，找到想要的，点**安装**。装完出现在最上面的「已安装 Skills」段，可随时删。

## 控制哪些 skill 会被注入

每个**运行配置**（Launch Profile）都带一份 Skill 策略，决定用它启动的会话能拿到哪些 skill。位置同上：资源中心 → Provider → 运行配置 → **Skill** 段，顶上三个模式按钮：

| 模式 | 行为 |
| --- | --- |
| **默认组合** | 启用 CC-Panes 内置 skill、运行配置 skill，并可附加工作空间项目 skill |
| **自定义选择** | 只注入你在下面逐条勾选的 |
| **不注入** | 这个配置不注入内置 / 运行配置 / 项目 skill |

下面依次是几个可勾选的区块：

- **CC-Panes 内置 Skill**——注意这里只列了 4 个高频的（`ccpanes-launch-task`、`ccpanes-dispatch-todos`、`ccpanes-browse-sessions`、`ccpanes-memory-dual-write`）。**这不代表另外 20 个不可用**：它们照样发布到磁盘、照样能用 `/ccpanes:xxx` 点名调用，只是默认不进"重点推荐"名单。想让某个也进，切到「自定义选择」手动勾。
- **External Skills**——按来源（Claude / Codex / Plugin）分组，可整组开关，也可逐条勾选。Claude 那组只对 Claude 配置生效，Codex 那组只对 Codex 生效。
- **Skill 市场**——市场条目直接在这里"安装并启用"，装完自动勾上。**只有装了并勾了才会注入这个运行配置。**
- **运行配置 Skill**——直接写在这份运行配置里的私货（名字 + 描述 + 正文），启动时随会话上下文注入，**不写进你的项目目录**。适合放"我个人希望这个 AI 怎么干活"这类要求。
- **工作空间项目 Skill**——勾上「启用项目 Skill」，当前工作空间下各项目 `.claude/commands` 里的 skill 才会参与。

<!-- TODO(img): 运行配置里的 Skill 段——三个模式按钮 + 内置/External/市场/运行配置/项目 五个区块 -->

## 常见问题

**我说了触发词，AI 却没走那个 skill。**
先确认这个会话用的运行配置里 Skill 模式不是「不注入」，以及对应的条目被勾上了。改完策略要**重开一个会话**才生效——skill 是启动时注入的，改设置不会影响已经在跑的实例。

**斜杠命令 `/ccpanes:xxx` 打出来没有补全。**
说明那批文件还没写到 CLI 的用户目录，或者你正在用的 CLI 不支持全局命令目录。CC-Panes 是在应用启动时发布的，装完新版本后**重启一次 CC-Panes**再开会话试试。

**项目级 skill 写好了，AI 看不见。**
两个常见原因：一是运行配置里没勾「启用项目 Skill」；二是文件位置不对——必须在**项目根目录**的 `.claude/commands/` 下，且扩展名是 `.md`。

**内置 skill 我不想要，能删掉吗？**
不建议手删——CC-Panes 每次启动会按版本号重新发布回去。要屏蔽，用运行配置的「不注入」或「自定义选择」；要彻底清干净（比如卸载前），走 [附录 A](appendix-a-data-and-troubleshooting.md) 的清理清单。

**市场那段一直是空的。**
索引是从网上拉的，离线或网络受限时拉不到就显示空。这只影响"能不能装新的"，已装的 skill 不受影响。

## 下一步

- 看这些 skill 背后的底座 → [用 MCP 让 AI 自己操控 CC-Panes](mcp-orchestration.md)
- 看编排类 skill 的实际用法 → [11. 多实例并行](11-parallel-run.md)、[12. Leader / Worker 编排](12-leader-worker.md)、[13. Plan → Codex 交接](13-plan-to-codex.md)
- 看 AI 怎么把结果画成界面给你 → [17. AI 面板](17-ai-panel.md)
- 回到 [手册首页](README.md)

# 1. CC-Panes 是什么、能帮你解决什么

> 一句话：**CC-Panes 是一个桌面端 AI 编程控制台**，把项目、终端、启动配置、Provider、Todo、文件浏览、Git、本地历史、会话恢复放进同一个工作台，方便你同时推进多个 AI Coding 任务。

它以 Claude Code 为核心，同时支持 Codex、Gemini、Kimi、GLM、OpenCode、Cursor 等 CLI。它不是单纯的"终端壳子"，而是给这些 CLI 工作流补上**项目组织、并行编排、上下文恢复和桌面工具链**。

更关键的是：CC-Panes 把这些能力都做成了 **MCP 工具**，让跑在里面的 AI 能*自己*操控整个工作台——开实例、调度任务、读写工作空间。这是它的灵魂，详见 [用 MCP 让 AI 自己操控 CC-Panes](mcp-orchestration.md)。

<p align="center">
  <img src="../assets/images/guide-terminal.png" alt="CC-Panes 工作区：左侧功能栏 + 工作空间树 + 中央 Claude 终端" width="860" />
</p>

## 它解决什么痛点

如果你经常用 Claude Code / Codex 这类 CLI 写代码，可能遇到过这些麻烦——CC-Panes 正是为它们而生：

| 你遇到的麻烦 | CC-Panes 怎么帮你 |
| --- | --- |
| 开了一堆终端窗口，来回切换找不到哪个是哪个 | 多个 AI 会话**分屏并排**运行，一个窗口管理全部 |
| 项目、任务、历史会话散落各处 | 工作空间 / 项目 / 任务 / Todo / 历史**统一管理** |
| 想接着昨天的会话继续，却忘了命令怎么敲 | 应用内一键**恢复历史 Claude/Codex 会话**（Resume） |
| 多个 API 账号、不同运行环境切换繁琐 | 启动时直接选 **Provider、运行环境、配置档** |
| 写代码还要不停切回 IDE 看文件、看 Git | 内置**文件浏览、编辑、本地历史、Git 工具** |
| 长时间工作流缺少趁手的桌面能力 | 截图、语音输入、通知、托盘、快捷键、迷你模式一应俱全 |

## 核心能力速览

**🤖 一切操作皆可被 AI 编排（MCP）—— CC-Panes 的灵魂**
- 内置 orchestrator MCP，把启动实例、读会话输出、建工作空间、派 worker、记 memory 等几乎所有操作都暴露成工具
- 跑在里面的 Claude / Codex 因此能**自己操控 CC-Panes**：你说“再开三个实例并行跑”，它自己开、自己盯、自己汇总
- 详见 [用 MCP 让 AI 自己操控 CC-Panes](mcp-orchestration.md)

**🖥️ 多实例终端**
- 基于 xterm.js + portable-pty 的真实 PTY 终端，支持分屏、标签、多面板布局
- 可启动 Claude Code、Codex、Gemini、Kimi、GLM、OpenCode、Cursor
- 记录启动历史，支持按项目恢复历史会话

**📁 工作空间与项目**
- 工作空间、项目树，支持置顶、隐藏、排序、扫描、导入、新建
- 每个项目有独立的启动历史、任务、Todo、MCP 配置
- 内置文件浏览器 + Monaco 编辑器 + Markdown / 图片预览

**⚡ 启动配置与 Provider**
- Launch Profile 管理 CLI、运行环境、Provider、Skill、环境变量的组合
- Provider 支持 Anthropic、Bedrock、Vertex、OpenAI 兼容代理、Gemini 等
- 启动时可**继承 Provider、显式指定，或不注入**

**🔀 Git、本地历史与审查**
- Git 分支状态、fetch / pull / push / stash / clone / worktree
- 分支感知的本地历史快照、标签、Diff 视图，可对比并恢复文件版本

**🪟 桌面工作流**
- 开发版 / 发布版数据目录、标识、快捷键完全隔离，可同时运行
- 全局截图、托盘、通知、语音输入、迷你模式、全屏聚焦
- 已发布 Windows、macOS、Linux 安装包

## 下一步

- 还没装？→ [2. 安装与第一次启动](02-install-and-first-launch.md)
- 想先理解它的组织方式？→ [3. 核心概念](03-core-concepts.md)
- 想直接上手？→ [4. 上手五步](04-getting-started-5-steps.md)

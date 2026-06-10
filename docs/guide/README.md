# CC-Panes 使用手册

> 这是 CC-Panes 面向**使用者**的操作手册——讲"这软件怎么用"。
> 如果你想了解"这软件怎么设计、怎么实现"（架构、各阶段设计、技术决策），请看上一级 [`docs/`](../) 里的设计文档。

CC-Panes 是一个面向 AI Coding 重度用户的多实例分屏工作台，以 Claude Code 为核心，同时支持 Codex、Gemini、Kimi、GLM、OpenCode、Cursor 等 CLI。这本手册帮你从零上手，并逐步掌握它的进阶玩法。

**图例**：✅ 已完成可阅读

> 手册中的界面配图为按**当前版本 UI 结构**绘制的示意图，用于说明操作位置；细节以你本地实际界面为准。

---

## 一、入门

从安装到跑起第一个 Claude，按顺序读这几篇即可上手。

1. ✅ [CC-Panes 是什么、能帮你解决什么](01-what-is-cc-panes.md)
2. ✅ [安装与第一次启动](02-install-and-first-launch.md)
3. ✅ [核心概念：工作空间 / 项目 / 任务 + Provider](03-core-concepts.md)
4. ✅ [上手五步：从空界面到跑起第一个 Claude](04-getting-started-5-steps.md)
5. ✅ [终端与分屏](05-terminal-and-panes.md)

## 二、日常使用

把每天都会用到的功能讲透。

6. ✅ [文件浏览与编辑、Markdown 预览](06-files-and-editor.md)
7. ✅ [Git 集成与 Worktree 管理](07-git-worktree.md)
8. ✅ [Local History：文件版本回滚与对比](08-local-history.md)
9. ✅ [把经验沉淀下来：Todo / 会话日志 / Memory](09-todo-journal-memory.md)
10. ✅ [设置详解（通用 / 终端 / 快捷键 / 代理 / Provider / 语音 / 截图…）](10-settings.md)

## 三、高级玩法（CC-Panes 的核心卖点）

多实例协作、AI 编排，是 CC-Panes 区别于普通终端的地方。**而这一切的底座，是它内置的 MCP——让 AI 能自己操控 CC-Panes。**

- ✅ [一切皆可编排：用 MCP 让 AI 自己操控 CC-Panes](mcp-orchestration.md)　★ 建议先读

11. ✅ [多实例并行跑任务](11-parallel-run.md)
12. ✅ [Leader / Worker 编排](12-leader-worker.md)
13. ✅ [Plan → Codex 交接 & Plan 同行评审](13-plan-to-codex.md)
14. ✅ [Resume：恢复历史会话](14-resume.md)
15. ✅ [WSL / SSH 远程运行](15-wsl-ssh.md)

## 四、参考

- ✅ [附录 A：数据存在哪 / 备份与排障](appendix-a-data-and-troubleshooting.md)
- ✅ [附录 B：快捷键速查](appendix-b-shortcuts.md)

---

## 反馈与交流

- GitHub Issues：<https://github.com/wuxiran/cc-pane/issues>
- GitHub Discussions：<https://github.com/wuxiran/cc-pane/discussions>

> 手册已覆盖从入门到高级编排的完整内容。若发现与实际界面不符或有错漏，欢迎到 Issues 反馈，我们会尽快修订。

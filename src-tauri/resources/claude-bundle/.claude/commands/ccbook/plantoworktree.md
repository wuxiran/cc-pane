---
name: plantoworktree
description: plan 派给 worker 且在独立 git worktree 中隔离执行 —— 等价于 plantocodex/plantocc 开启「worktree 隔离模式」。Use when 用户说"派到 worktree"、"隔离着跑"、"别动我主树"、"plantoworktree"。
---

# plantoworktree — 入口别名（stub）

> **会话状态判读、停手规则与收尾字段以 [`docs/65 · Skill 观测契约`](../../../docs/65-skill-observation-contract.md) 为准**，本文不再复述。
> 三条最常踩的：`idle` + `turnSeq: 0` **且 PTY 零输出** = prompt 未提交（发裸 CR，**不要 kill 重发**）——
> 三个条件缺一不可；**PTY 有输出时多半是在等你选**，此时发 CR 会盲选一项；
> `status` 单独不可信，判活要看 `lastOutputAt` 停滞 + 进程存活；
> 动手写之前先核身份——`$CC_PANES_LAUNCH_ID` 必须等于所连 MCP URL 里的 `launchId`，不等即串台。

本 skill 是入口别名，不含独立流程。执行方式：

1. 按 [`/ccbook:plantocodex`](plantocodex.md)（派 Codex）或 [`/ccbook:plantocc`](plantocc.md)（派 Claude worker）的完整流程执行
2. **强制启用**其中的「可选：worktree 隔离模式」章节（派发前增量 + 收尾增量）

流程真身只维护在 plantocodex 一处，本文件永不扩写。

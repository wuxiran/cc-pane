---
name: plantoworktree
description: plan 派给 worker 且在独立 git worktree 中隔离执行 —— 等价于 plantocodex/plantocc 开启「worktree 隔离模式」。Use when 用户说"派到 worktree"、"隔离着跑"、"别动我主树"、"plantoworktree"。
---

# plantoworktree — 入口别名（stub）

本 skill 是入口别名，不含独立流程。执行方式：

1. 按 [`/ccbook:plantocodex`](plantocodex.md)（派 Codex）或 [`/ccbook:plantocc`](plantocc.md)（派 Claude worker）的完整流程执行
2. **强制启用**其中的「可选：worktree 隔离模式」章节（派发前增量 + 收尾增量）

流程真身只维护在 plantocodex 一处，本文件永不扩写。

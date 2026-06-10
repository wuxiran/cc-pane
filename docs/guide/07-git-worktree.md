# 07. Git 集成与 Worktree

> CC-Panes 内置了常用 Git 操作和 Worktree 管理，省得频繁切到命令行。

## Git 操作

CC-Panes 会显示当前项目的**分支名**和**是否有未提交改动**。内置的 Git 操作有：

- **拉取（pull） / 推送（push） / 获取（fetch）**
- **暂存（stash） / 弹出暂存（stash pop）**
- **从 Git 克隆**：在工作空间右键 → 「从 Git 克隆」，填仓库地址和本地目录，克隆完自动登记为项目

> 说明：当前内置的 Git 能力聚焦在 **拉取 / 推送 / 获取 / 暂存 / 克隆** 和**状态查看**；**切换、新建、删除分支**这类操作，请在终端里用 `git` 命令完成。

## Worktree 管理

Git Worktree 让你把不同分支**同时**检出到不同目录，并行开发、互不干扰。

打开方式：右键项目 → 「Worktree 管理」。可以：

- **列出**现有 worktree
- **新建** worktree（可指定分支）
- **删除** worktree（主工作目录不可删）
- **打开**它的目录，或在其中**启动终端**

> [多实例并行](11-parallel-run.md) 正是靠 worktree 给每个 worker 一份独立副本，来避免并行改代码时互相冲突。

## 下一步

- [08. Local History](08-local-history.md)
- 回到 [手册首页](README.md)

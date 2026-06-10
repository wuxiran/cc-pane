# 附录 A：数据存在哪 / 备份与排障

## 数据存在哪

CC-Panes 的数据分两层。

**全局目录**（默认 `~/.cc-panes/`；开发版是 `~/.cc-panes-dev/`，两者完全隔离）：

| 内容 | 说明 |
| --- | --- |
| `data.db` | SQLite 主库：项目、启动历史、Todo、终端会话等 |
| `providers.json` | Provider 配置 |
| `launch-profiles.json` | 启动配置 |
| `memory.db` | Memory 记忆库 |
| `shared-mcp.json` | 共享 MCP 配置 |
| `workspaces/<名字>/` | 各工作空间（含 workspace.json、会话日志、快照） |
| `sessions/` | 终端输出文件 |
| `skills/` | 内置与自定义 skill |
| `screenshots/` | 截图 |

**项目级目录**（每个项目下的 `.ccpanes/`，跟着仓库走）：

| 内容 | 说明 |
| --- | --- |
| `history/` | Local History 文件版本快照 |
| `hooks/` | 工作流定义 |
| `specs/` | Spec 文件 |
| `config.toml` | 项目配置 |

> Claude / Codex 各自的**会话上下文**不在这里，而在它们自己的目录（如 `~/.claude/`、`~/.codex/`）——[Resume](14-resume.md) 恢复会话就靠它们。

## 开发版 / 发布版互不相通

这是设计如此：`~/.cc-panes/`（发布版）和 `~/.cc-panes-dev/`（开发版）是两套独立数据。所以你在开发版里建的工作空间，发布版看不到——这不是 bug，是有意隔离。

## 迁移数据目录

想把数据放到别的盘？**设置 → 通用 → 数据目录**：可以查看当前大小、迁移到新位置、或恢复默认。**改后需要重启应用生效。**

## 备份

最简单：整个复制 `~/.cc-panes/` 目录（发布版）。如果还想保住 AI 的历史对话，连 `~/.claude/`、`~/.codex/` 一起备份。

## 常见排障

- **项目打不开 / 找不到**：项目目录被移动或删除了 → 在侧边栏重新导入。
- **会话恢复不了**：会话已经退出（exited）就没法 Resume，只能新建。
- **开发版和发布版数据对不上**：正常，它们本就隔离（见上）。
- **想看日志**：设置 → 关于 → **打开日志目录**。
- **数据目录占用变大**：`history/`（Local History 快照）和 `sessions/` 会随用量增长，可按需清理。

## 下一步

- [附录 B：快捷键速查](appendix-b-shortcuts.md)
- 回到 [手册首页](README.md)

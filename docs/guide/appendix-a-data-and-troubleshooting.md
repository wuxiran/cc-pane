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

## 卸载与手动清理

仍能打开 CC-Panes 时，先使用**设置 → 关于 → 卸载前清理**。它会撤销能确认由 CC-Panes 写入的 CLI 全局文件和已注册项目 hook，并报告已清理、已跳过和失败项；不会删除工作空间、会话或其他应用数据。

Windows 交互卸载随后会询问是否删除应用数据，默认选择“否”。选择“是”只处理下列三个固定路径；`/S` 静默卸载和 updater 升级始终保留数据：

- `%APPDATA%\com.ccpanes.app`
- `%LOCALAPPDATA%\com.ccpanes.app`
- `%USERPROFILE%\.cc-panes`

自定义 `data_dir` 不在卸载器的删除范围内。可以在卸载前从**设置 → 通用 → 数据目录**确认实际位置；已经卸载时，需从原配置或备份中确认后手动处理。若上述固定目录是 junction/reparse point，不要让卸载器递归删除，应选择“否”并先确认链接的真实目标。

已经卸载的老版本可按下面清单逐项检查。删除前先备份；配置文件只删除明确带 CC-Panes 所有权特征的条目，不要整文件删除。

| 位置 | 手动处理边界 |
| --- | --- |
| `~/.claude/commands/ccpanes/` | 整个目录属于 CC-Panes 命名空间，可删除 |
| `~/.claude/skills/ccpanes-*`、`~/.codex/skills/ccpanes-*` | 只删除 `ccpanes-` 前缀目录和 `.ccpanes-default-skills-version` |
| `~/.grok/config.toml` | 只删除 URL 为 loopback、路径含 `/mcp` 且带 `token=` 的 `[mcp_servers.ccpanes]`；其他同名 server 保留 |
| `~/.claude.json.ccpanes.bak` | 确认不再需要恢复 Claude 配置后删除 |
| `<项目>/.claude/settings.local.json` | 只移除 command 含 `cc-panes-cli-hook` 或旧名 `cc-panes-hook` 的 hook entry |
| `<项目>/.codex/hooks.json` | 同上，只移除带 hook 二进制签名的 entry |
| `<项目>/.opencode/plugins/ccpanes.js` | 仅在确认内容是 CC-Panes 内置插件时删除 |

`.codex/config.toml` 的通用 `hooks` / `codex_hooks` feature flag 没有独立所有权标记，应用内清理会保守地保留它们。除非确认没有其他 Codex hook 依赖，否则不要手动删除。

Windows 卸载器通常会移除 `ccpanes://` 协议注册。仍有残留时检查当前用户注册表的 `HKEY_CURRENT_USER\Software\Classes\ccpanes`；只有键值仍指向已卸载的 CC-Panes 可执行文件时才删除该键。开发版协议是独立的 `ccpanes-dev`，不要一并删除。

## 常见排障

- **项目打不开 / 找不到**：项目目录被移动或删除了 → 在侧边栏重新导入。
- **会话恢复不了**：会话已经退出（exited）就没法 Resume，只能新建。
- **开发版和发布版数据对不上**：正常，它们本就隔离（见上）。
- **想看日志**：设置 → 关于 → **打开日志目录**。
- **数据目录占用变大**：`history/`（Local History 快照）和 `sessions/` 会随用量增长，可按需清理。

## 下一步

- [附录 B：快捷键速查](appendix-b-shortcuts.md)
- 回到 [手册首页](README.md)

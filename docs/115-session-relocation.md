# 115 · 项目改路径后的会话迁移

## 项目路径移动 / 改名后迁移历史会话

入口：项目右键菜单「迁移历史会话…」（仅桌面端、非 SSH 项目）。项目路径已失效时把它预填为旧路径，
否则把当前路径预填为新路径。对话框先「预览」（`dryRun: true`），预览后路径没改过、且有可迁移项时
才能「迁移」。命令 `relocate_project_sessions`，实现在 `cc-panes-core/src/services/session_relocation/`。

| 对象 | 做法 |
| --- | --- |
| Claude Code | `<projects>/<编码路径>/` 里的会话逐个移到新编码目录（含同名的 subagents / tool-results 目录），只改每行顶层 `cwd`（及 `/cd` 的 `relocatedCwd`），保留 mtime。新目录下已有同名会话跳过并报告。`memory/` 等非会话条目在新目录没有同名项时一并移过去。目录名按 Claude Code 规则（非字母数字换成 `-`），也认 CC-Panes 旧编码。默认目录和各登录账号目录都处理。 |
| Codex | 会话按日期存放，路径不参与寻址。按 `session_meta.payload.cwd` 认领，只改 `session_meta` / `turn_context` 行的 `payload.cwd`，原地改写并保留 mtime。不碰 Codex 的 sqlite 状态库。 |
| CC-Panes | `launch_history.project_path / launch_cwd`、`task_bindings.project_path`，一个事务内改完。 |

安全：

- 只改「等于旧路径或以旧路径 + 分隔符开头」的字段；`/a/b` 不会命中 `/a/bc`。消息正文、工具参数里的历史路径不改。
- 动任何文件前先把原件拷到 `<data>/backups/session-relocation/<时间戳>/`（`claude/<根序号>/<目录名>/`、
  `codex/<根序号>/<相对路径>`、`records.json`），最后写 `manifest.json`（本次报告）。
- 一分钟内被写过的会话视为可能还开着，跳过（`active`）；不是合法 JSONL 的会话跳过（`invalid`）。
- 新旧路径相同、互相嵌套、不是绝对路径、是根目录时直接拒绝。
- 根目录全部经 `RelocationRoots` 注入；测试只用临时目录。

未覆盖：WSL / SSH 里的会话存储、Claude 超长路径（目录名被截断加哈希）、Claude Desktop 的独立存储。

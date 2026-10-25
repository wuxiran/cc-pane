---
name: ccpanes-codex
description: Delegate an independent coding or review task to Codex App Server, or prepare a task draft for the Codex Mac client. Use when asked to call Codex, have Codex review or implement work, or hand work to the Codex desktop app. Preserve the requested execution target.
---

# Codex 派工

将用户授权的独立任务交给 Codex。先形成简短、自包含的任务说明：目标、工作目录、文件范围和验收要求。现有指令和授权范围沿用，不要求用户重复确认已明确的目标。

控制程序绝对路径在 `CC_PANES_CTL`，不保证在 PATH；POSIX shell 用 `"$CC_PANES_CTL"`，PowerShell 用 `& $env:CC_PANES_CTL`。缺少变量或命令时明确说明当前会话尚未挂载新版本，不猜安装路径、不安装替代程序。先运行 `"$CC_PANES_CTL" codex --help` 确认当前版本支持所选入口；不要打印整个环境或配置。

## 按用户指定的目标派发

### Codex Mac 客户端

用户指定“Mac 客户端”“桌面 Codex”“在桌面执行”时，用桌面交接入口。它只打开新聊天并预填任务，**不会自动发送**，也不调用 `codex queue` 或启动独立 App Server 冒充桌面执行。

将说明用文件工具写入 UTF-8 任务文件（避免把用户文字拼进 shell）。说明最多 8 KiB；长计划保存为本地文件，在短说明中引用其绝对路径，不截断任务。

```sh
"$CC_PANES_CTL" --json codex handoff --cwd "/absolute/project" --prompt-file "/absolute/task.txt"
```

返回 `status: "awaiting_user_send"`、`submitted: false` 表示已请求系统打开草稿。告诉用户去 Codex 点击发送；不能报告“已开工”“正在执行”或“完成”。`--dry-run` 只生成链接，状态为 `draft_prepared`，连应用也没打开。现有线程链接不能追加任务。仅执行一次交接；结果不明确时先报告，不重复打开多个聊天。保留原会话的草稿和正在执行的工作。

### Codex 后台 / App Server

用户要求直接调用 Codex 编码或审查、且没有指定桌面目标时，使用后台原生入口。工作目录取当前任务实际目录；并发修改同一仓库时先遵守项目的文件分工或 worktree 约定。

```sh
"$CC_PANES_CTL" --json codex run "只读审查当前修改，报告具体问题，不修改文件" --cwd "/absolute/project" --sandbox read-only
```

审查用 `--sandbox read-only`；已授权实现时用默认 `workspace-write`。真实任务文字通过工具的参数数组或可靠 shell 引号传入，不能把反引号、`$()` 或引号当成可执行代码拼接。没有明确模型要求时沿用配置；要选模型，先运行 `codex models`，不编造模型名。

读取 JSONL：`type: "started"` 给出本次 `threadId` 和 `turnId`；`item/agentMessage/delta` 是回复片段，`turn/completed` 的 `turn.status` 才是回合终态。退出码 0 且状态 `completed` 表示本轮执行结束；不等于验收自动通过，仍需查看结果与实际改动。

需要继续同一任务时传 `--resume THREAD_ID`；独立分支任务用 `--fork THREAD_ID`。只使用实际返回的 ID，不从文字标题猜测，不并发续接仍在运行的同一线程。长任务使用调用环境提供的进程句柄等待输出，不把等待超时当成“没启动”重新派一遍。

非交互/JSON 模式不会自动批准权限或编造问答。退出码 4 表示有未处理的审批或提问，报告需要人工处理；不改成绕过审批。退出码 2 为执行/协议错误，3 为参数错误，130 为中断。失败或结果不明确时先读取现有输出，不自动重派可能已产生改动的任务。

## 交付

汇报实际执行目标、线程 ID（若有）、结果和验证证据。桌面交接只报告“待发送”。若需要 CC-Panes 中可见的独立终端、任务绑定与 worker 回执，改用已有 `ccpanes-dispatch-task`，不要宣称本命令创建了 PTY worker。

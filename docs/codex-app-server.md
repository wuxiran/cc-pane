# Codex App Server 接入

CC-Panes 提供三个独立入口，已有会话不会自动迁移：

| 入口 | 执行方式 |
| --- | --- |
| 终端中的 Codex | 原有 Codex CLI / TUI，保持原样 |
| Agent 的 Codex (ACP) | 原有固定版本 `codex-acp` 适配器 |
| Agent 的 Codex App Server、`cc-panes-ctl codex` | 本机 `codex app-server` 的原生双向 JSON-RPC 协议 |

需要本机安装并登录 Codex CLI。原生接入直接解析本机 `codex` 可执行文件；不下载 ACP 包，不读取或展示登录凭据。当前按 Codex CLI 0.162.1 生成的协议及官方文档校对。App Server 为实验性接口，升级 CLI 后应重新跑兼容性验收。

## 桌面入口

Agent 启动页选择 **Codex App Server**。CLI 的 Codex 标签右键可新建该引擎的 Agent 对话；原终端保留，新页面预选引擎，不自动发送任务或恢复正在运行的 CLI 线程。

原生 Agent 支持流式回复、工具输出、截图输入与 MCP 图片结果、模型与思考深度、审批与表单提问、停止、恢复和分叉。继续使用现有运行记录和整轮变更审阅。历史里的图片保留引用或占位，不承诺恢复原始缩略图；App Server 文件补丁不包含完整旧文件时，不提供单工具撤销，改用有可靠快照的整轮审阅。无法确认后台命令已结束时，快照保留可读并禁用还原。

CLI 标签右键和 Codex Agent 的更多菜单提供 **在 Codex 中打开**：

- 已确认的原生线程 ID 使用 `codex://threads/<id>`。
- 没有可靠 ID 时使用 `codex://new?path=...` 打开项目的新对话。
- ACP 会话 ID 不自动当作 Codex 线程 ID。
- 链接正确编码目录和草稿；预填草稿不会自动发送。
- 仅支持本地桌面目标。WSL、SSH 与网页模式不把远程路径当作本机路径。

## CLI

命令不依赖已运行的 CC-Panes daemon。`--json` 放在 `codex` 前面，输出 JSONL。

```sh
cc-panes-ctl --json codex models
cc-panes-ctl --json codex threads --cwd /absolute/project
cc-panes-ctl codex run "检查这次修改" --cwd /absolute/project --sandbox read-only
cc-panes-ctl codex run "继续实现" --cwd /absolute/project --resume THREAD_ID
cc-panes-ctl --json codex run "独立审查" --cwd /absolute/project --fork THREAD_ID
```

`run` 执行一轮并持续读取事件；可以用输出的线程 ID 继续或分叉。默认 `workspace-write` + `on-request`，`--sandbox read-only` 可限制工作区写入。`--model` 可选择 `models` 返回的模型，未指定则使用本机 Codex 配置。不要从另一入口同时继续一个正在运行的线程；需要独立执行时使用分叉。

交互终端会显示命令/文件/权限审批，只有明确输入 `y` 才单次同意；普通提问支持选择编号或自由文字。管道和 JSON 模式不自动放行或猜测答案，未处理的审批/提问会拒绝并以退出码 4 报告。MCP 表单/URL 和秘密输入在 CLI 中不收集，返回拒绝，可改用 Agent 界面处理支持的表单。若服务器在终端等待输入时撤销当前问题，CLI 会停止本次运行并提示恢复线程，避免旧输入误答后续审批。

Ctrl-C 中断本次回合并回收本次启动的进程，退出码 130；回合超时或协议/模型错误退出码 2，参数错误退出码 3。默认最长 1800 秒，可用 `--timeout` 调整。不会关闭其他 CLI、Agent 或 Codex 桌面会话。

## 实现与验证边界

`cc-panes-core::services::codex_app_server` 负责私有 stdio 进程、握手、请求配对、有界超时、审批响应、流式事件和进程回收。Agent 层把原生线程/回合事件转换为现有消息、运行记录和审批 UI；CLI 复用同一传输。

这不是对 Codex 桌面 UI 的远程控制服务，也不接管其 daemon。核心客户端不接受网页传入任意执行文件。未知服务器请求明确拒绝；事件队列溢出报告错误并停止，避免静默丢失审批或结束事件。

自动化回归使用本地假服务器验证协议与生命周期。本机真实握手和模型列表验证不等于付费模型回合、Windows 原生进程回收或桌面深链接完整验收；每次交付应单独报告这些边界。

官方协议：[App Server](https://learn.chatgpt.com/docs/app-server)；桌面跳转：[Deep links](https://learn.chatgpt.com/docs/app/commands)。

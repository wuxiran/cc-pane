# 聊天分叉功能实现与验证

聊天分叉已接入 CLI 终端与内置 Agent Chat，均提供同目录和独立 Git 工作树两种方式。代码位于 `codex/feat-chat-fork`，工作树为 `/Users/wuxiran/workspace/rust/cc-pane-chat-fork`。功能提交基于审阅修复分支的 `8093cd61`；最终业务代码为 `c35b8f35`。

## 使用方式与范围

- CLI 终端：右键 Claude Code 或 Codex 标签，选择“创建聊天分叉”。分屏标签使用当前选中的 leaf 的对话 ID。首次启动使用原生分叉参数；捕获子会话 ID 后，重启会恢复子会话。
- Agent Chat：会话顶部更多菜单中选择“创建聊天分叉”。等待当前回复结束后可用。只向声明 `sessionCapabilities.fork` 的引擎发送 `session/fork`，返回 ID 必须不同于父会话。失败不会退回恢复父会话或创建空会话。
- 同目录模式共享项目文件，但消息分别保存在独立会话中。
- 独立工作树模式从当前提交创建新分支，复制已跟踪文件的未提交内容和非忽略的新普通文件，并保留原来的子目录工作位置。源目录及暂存区不变。未跟踪符号链接、嵌套仓库等无法完整复制的情况会报错并回收本次创建的工作树。

工作树模式适用于已有提交的本机 Git 仓库。WSL CLI 已接入同目录分叉；SSH 分叉和 WSL 工作树创建未接入。工作树创建成功但引擎启动失败时，保留目录并在错误中显示路径，避免丢弃已经复制的文件状态。

Codex ACP 固定从 `1.7.0` 升至 `2.2.2`。实际初始化检查确认后者在协议 v1 下声明分叉能力；Claude ACP 保持 `0.70.0`。前端复制可见转写，不复制父会话的待审批请求、运行中工具终端或用量状态。

实现使用 [Codex 原生 fork](https://learn.chatgpt.com/docs/developer-commands?surface=cli) 和 [ACP ForkSessionRequest](https://agentclientprotocol.github.io/typescript-sdk/types/ForkSessionRequest.html) / [ForkSessionResponse](https://agentclientprotocol.github.io/typescript-sdk/types/ForkSessionResponse.html) 契约。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 前端完整测试 | 614 个文件、5917 项通过；后续新增入口与按需加载调整另跑最终补验 |
| 最终分叉与入口补验 | 6 个文件、35 项通过 |
| Rust workspace 完整测试 | 2767 项通过，0 失败，2 项既有忽略；已扣除 4 个跨进程夹具重复摘要 |
| 工作树集成测试 | 真实临时 Git 仓库验证未提交内容、新文件、子目录、源暂存区不变及失败回收 |
| CLI 分叉参数回归 | Claude/Codex 原生命令、独立 ID、重启恢复子会话、无效参数拒绝 |
| ACP 回归 | 能力校验、源 ID 与目标目录请求、独立子 ID、错误传播且不回退 |
| TypeScript | 通过 |
| 前端生产构建与 xterm 检查 | 通过 |
| Rust workspace 构建 | 通过 |
| 主线组合严格 Clippy | 通过，未放宽告警规则 |
| 主线组合包体预算 | 入口 gzip 879.7 KB，通过 880 KB 门槛 |
| 浏览器界面检查 | 两个模式可见，工作树选项可选，文本与按钮无裁切 |
| 四个 debug 侧车 | 重建并同步，构建目录、运行时 binaries 与本分支 src-tauri/binaries 的 SHA256 一致 |

完整 Rust 测试中的既有 Finder 回收站用例在 macOS 挂起超过 60 秒。仅终止该用例创建的 osascript 子进程后，用例通过允许回收站失败的目标完整性断言。真实 Finder 删除没有验证成功，其余测试正常完成。

本轮进行了适配器初始化、请求契约和临时仓库测试，没有向真实模型会话发送测试消息。Windows 桌面、WSL 实机和真实模型父子并行对话仍需验收。使用新功能应运行本分支构建，并按正常流程重启应用及旧 daemon 以加载新侧车；本轮没有中断用户正在运行的会话。

## 与其他修复分支的兼容

主线修复提交 `e8e71f7e` 与本功能的 Git 三方合并无冲突。组合快照运行了严格 Clippy、前端构建、入口回归及包体检查；原主线工作树未修改。补充审阅修复分支也完成了合并冲突检查。

本分支尚未单独纳入主线负责的既有非 Windows dead_code 修复；严格 Clippy 的通过结果对应组合快照。最终包体优化将对话框和启动逻辑改为按需加载，不放宽已有预算。

## 证据

- [完整前端日志](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-chat-fork/frontend-full.log)
- [完整 Rust 日志](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-chat-fork/rust-full.log)
- [最终入口回归](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-chat-fork/final-entrypoint-tests.log)
- [集成 Clippy](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-chat-fork/integrated-clippy-final.log)
- [集成包体预算](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-chat-fork/integrated-bundle-final.log)
- [适配器能力检查](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-chat-fork/adapter-capabilities.json)
- [侧车校验](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-chat-fork/sidecar-sha256.json)
- [界面预览](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-chat-fork/fork-dialog.png)

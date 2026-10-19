# 分叉采纳与任务验收实现验证

`codex/feat-chat-fork` 实现了分叉结果对比与采纳、任务验收卡。工作树为 `/Users/wuxiran/workspace/rust/cc-pane-chat-fork`，功能提交为 `4f3f20d8`，设计规范与审批兼容补验提交为 `6b1e6766`。两个功能均接入桌面命令与 Web API。

## 使用方式

- CLI 终端标签右键菜单或 Agent Chat 会话菜单打开“比较分叉结果”。新建分叉会保存独立基线；可切换同源候选方案，查看相对基线的修改及候选之间的内容差异。
- 独立工作树分叉可以按文件或文本代码片段采纳到父目录。新增、删除、二进制和文件模式变化按整文件处理。父目录独立修改通过三方合并保留；冲突、预览过期或不支持的文件会被拒绝。同目录会话共享文件，显示共享目录提示，不提供重复采纳。
- 任务详情新增“验收证据”。输入检查命令并明确运行后，记录工作目录、原始 Git 提交、代码指纹、真实退出码、终止信号、耗时及 stdout/stderr。每次运行单独保存，任务标记完成不会自动生成通过记录。
- 只有检查成功、前后代码指纹与当前报告一致、观察正常且未在运行或刷新时，卡片才显示“通过 · 当前代码”。代码变化后显示过期，状态无法确认时显示未验证；每 10 秒、窗口重新获得焦点或手动点击时刷新。

## 文件与执行边界

基线和采纳前备份保存在应用数据目录下的私有快照仓库，源仓库的 HEAD、引用、暂存区和对象库不作为快照存储位置。采纳前保存恢复快照，先检查整批选择，再逐个安全替换；写入失败尝试回滚，并保留第三方同期修改。写入成功后刷新失败仍返回采纳成功与明确提示。

比较与验收需要本机已有提交的 Git 仓库。非 Git 同目录聊天仍可分叉，但没有代码基线；旧分叉不会伪造基线。同目录修改不能归属到某一个会话。SSH、WSL 宿主之外的工作目录、gitlink/子模块及特殊文件不自动采纳。每次比较最多 200 个变化文件，单文件预览最多 2 MiB、总预览最多 16 MiB；界面每页最多渲染 2000 行并明确标注截断，采纳使用完整选中的内容。

创建工作树前检查源快照与记录存储。工作树创建后的意外错误保留新目录并返回恢复路径，避免删除用户已经写入的文件。合并临时目录和验收证据目录在 Unix 上使用 0700，验收证据文件使用 0600，拒绝管理目录符号链接。

验收命令超时范围为 1–600 秒，每个输出流最多保存 64 KiB。超时和主命令退出后清理所属子进程；Unix 先保留进程身份再清理，另用继承标识补充发现脱离进程组的后代；Windows 使用 Job Object。任务锁跨进程生效，Unix 子进程继承锁，主应用异常退出后不会把仍运行的检查误报为已完成。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 前端完整测试 | 621 个文件、5956 项通过，0 失败 |
| Rust workspace 完整测试 | 2828 项通过、0 失败、2 项既有忽略；扣除跨进程夹具重复的 4 个摘要 |
| TypeScript、Rust 格式检查 | 通过 |
| 前端生产构建与 xterm 分包 | 通过 |
| 当前分支包体预算 | 入口 gzip 879.9 KB，通过 880 KB 门槛 |
| Rust workspace 构建 | 通过 |
| 主线组合严格 Clippy | 通过，使用 `-D warnings` |
| 主线组合前端补验 | 38 个文件 260 项，加独立设计 token 检查 7 项，全部通过 |
| 主线组合 Web 路由回归 | 102 项通过 |
| 主线组合类型与生产构建 | 通过；入口 gzip 875.8 KB |
| 四个 debug 侧车 | 重建并同步，构建目录、应用 binaries 与运行时 binaries 三处 SHA256 一致 |

回归覆盖真实临时 Git 仓库、未提交基线、第二个片段偏移、冲突整批拒绝、只采纳无冲突片段、父子预览过期、二进制/新增/删除、暂存区保持、符号链接逃逸、发布回滚、首次并发快照初始化、验收证据跨重启保存、执行中改动后还原、超时与后台子进程清理，以及任务锁继承。

完整 Rust 测试中的既有 Finder 回收站用例等待超过 60 秒。仅终止该用例创建的 `osascript` 子进程后，通过了允许回收站失败的目标完整性断言；真实 Finder 删除仍未验证。未中断用户应用或 daemon。

## 与主线修复的兼容

以主线修复 `62d4b373` 建立独立临时组合快照，保留本功能与主线修复的行为。源代码三方合并没有文本冲突；合并后新分叉入口和主线新重启流程共同淘汰了一处旧导入，需要删除失效的 `loadAutoApproveKinds` 导入。`docs/94-acp-agent-chat.md` 有一处文本冲突，组合快照保留了原生分叉说明与主线停止/进程清理说明。审批回归已改为通过公共事件入口注入，兼容单项审批和主线审批队列。

[组合修补文件](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-fork-review-verification/integration-resolution.patch) 只包含上述两处合并整理，已通过应用检查；组合后的类型、测试、构建和严格 Clippy 均通过。主线工作树未修改。补充修复分支 `96ff0ac5` 的三方合并无冲突。

本分支未重复加入主线负责的既有非 Windows `dead_code` 修复，因此严格 Clippy 的通过结果对应组合快照。使用新构建时需按正常流程重启应用和旧 daemon 加载侧车；本轮没有主动重启。

浏览器使用合成夹具检查实际组件的中文深色界面、片段勾选、采纳按钮状态和验收详情展开，没有向真实模型发送消息，也没有采纳用户项目内容。Windows 桌面运行、Windows Job Object 行为和 WSL 实机尚未验证。

## 验证证据

- [分叉对比界面](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-fork-review-verification/fork-review-preview.png)
- [验收卡界面](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-fork-review-verification/verification-card-preview.png)
- [前端完整测试](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-fork-review-verification/frontend-full-final.log)
- [Rust 完整测试](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-fork-review-verification/rust-full-final.log)
- [生产构建](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-fork-review-verification/build-final.log)
- [包体预算](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-fork-review-verification/bundle-final.log)
- [主线组合 Clippy](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-fork-review-verification/integrated-clippy.log)
- [主线组合前端测试](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-fork-review-verification/integrated-frontend-final.log)
- [主线组合路由测试](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-fork-review-verification/integrated-http.log)
- [侧车 SHA256](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-fork-review-verification/sidecar-sha256.json)

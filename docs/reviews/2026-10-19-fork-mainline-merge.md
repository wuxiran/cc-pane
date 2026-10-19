# 分叉对比与任务验收主线合并验证

将功能分支 `codex/feat-chat-fork` 的 `f98a189f` 合并到承载本轮主线修复的 `codex/fix-dev01222-audit`，合并前主线为 `92058b5a`。目标工作树为 `/Users/wuxiran/workspace/rust/cc-pane-audit-fixes`。此次采用保留双方历史的 merge，不替换主线文件树。

## 合并处理

本次主线已包含聊天时间线、会话控制区拆分、分叉来源重验及子会话历史回放修复。实际冲突位于 `AgentChatTabContent.tsx`、`ChatSessionHeader.tsx` 和 `agentChatFork.test.ts`；均以主线的新结构为基础接入分叉比较、持久化 `forkReviewId` 和任务验收功能。

- 保留 `ChatSessionControls`、时间线布局、审批队列与配置恢复流程，未恢复旧控制栏和旧偏好导入。
- 分叉准备前后重新校验来源会话、引擎、工作目录和运行状态；准备服务动态加载后也重新检查。预分配的子标签 ID 写入基线记录，创建成功后保存来源标签与比较记录 ID。
- 保留 `seedFork` 的子会话 ID 和历史前缀参数，避免恢复历史时重复正文或丢失原有跨目录前缀。审批隔离测试通过公共事件入口注入，同时保留主线完整的回放回归。
- 文档自动合并保留了原生分叉与主线停止、进程清理说明，并把 `session/fork` 的协议覆盖状态更新为已支持。旧临时集成补丁未套用到已经重构的主线。

主线已有 493 个 Rust 文件中，467 个内容完全相同；其余 26 个仅增加服务/命令/路由接线、测试状态和测试可见性。新增 32 个 Rust 文件与功能分支相同。另逐项核对了 16 个关键主线文件，包含会话控制区、历史回放、时间线、审批事件、依赖锁、鉴权、进程保护、任务队列、历史恢复与工作空间持久化，内容均保持一致。

## 合并后验证

| 检查 | 结果 |
| --- | --- |
| 前端完整测试 | 638 个文件、6050 项通过，0 失败 |
| Rust workspace 完整测试 | 2887 项通过、0 失败、2 项既有忽略；已扣除跨进程夹具重复的 4 个摘要 |
| 冲突相关前端补验 | 78 项通过，包含来源重验、基线身份、准备失败、非 Git 分叉、时间线、审批隔离与子会话回放 |
| TypeScript、Rust 格式检查 | 通过 |
| 严格 Clippy | `cargo clippy --workspace --locked -- -D warnings` 通过 |
| 前端生产构建与 xterm 检查 | 通过 |
| 入口包体预算 | gzip 876.3 KB，通过 880 KB 门槛 |
| 文档站构建 | 通过，主线的内部审阅记录排除规则保留 |
| Rust workspace 构建及侧车同步 | 通过；四个 debug 侧车在构建目录、主线应用目录、独立构建运行时和默认 `cc-book-target` 运行时的 SHA256 一致 |

以上验证在当前 macOS 环境执行。Windows 桌面、Job Object 和 WSL 实机行为不在本轮验证范围。本轮完整 Rust 测试正常结束，没有中止 Finder 用例子进程。

## 证据

- [前端全量日志](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-fork-mainline-merge/frontend-full.log)
- [Rust 全量日志](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-fork-mainline-merge/rust-full.log)
- [Rust 计数汇总](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-fork-mainline-merge/rust-summary.json)
- [主线 Rust 保留核对](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-fork-mainline-merge/rust-preservation.json)
- [关键主线文件核对](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-fork-mainline-merge/critical-mainline-preservation.json)
- [严格 Clippy](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-fork-mainline-merge/clippy.log)
- [包体预算](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-fork-mainline-merge/bundle.log)
- [文档构建](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-fork-mainline-merge/docs-build.log)
- [侧车校验](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-fork-mainline-merge/sidecar-sha256.json)

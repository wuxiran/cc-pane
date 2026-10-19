# dev0.12.22 第四轮问题修复验证

本轮在 `codex/fix-dev01222-deep-audit` 上修复了新审阅确认的 9 项问题：5 个 P1、4 个 P2。最终代码提交为 `69fbbd56`；此前的 23 项审阅修复仍保留。主线当前提交为 `2905ad22`，其中包含设置面板懒加载等独立变更。

## 修复清单

| 编号 | 优先级 | 修复行为 |
| --- | --- | --- |
| G01 | P1 | Files 编辑内容按标签 ID 保存在进程内 buffer，切换标签或 Files 视图不会丢失未保存内容；关闭时才释放 buffer，脏标签继续使用确认对话框。干净 buffer 重新挂载会刷新磁盘/远端内容，脏 buffer 保留编辑内容。 |
| G02 | P1 | SSH 删除、改名只解析父目录，叶子符号链接通过 `lstat` 保留链接本身，不再递归删除或改名链接目标。 |
| G03 | P1 | SSH 新建文件使用 `WRITE | EXCLUSIVE` 原子创建；重名和并发创建失败且原文件内容不变。 |
| G04 | P1 | daemon 仅对 GET/HEAD 的失联请求自动重试。已经发送的写入/提交在响应丢失时返回 `DAEMON_REQUEST_OUTCOME_UNKNOWN`，明确提示可能已执行，避免重复输入。 |
| G05 | P1 | SSH 跳板保存、连接和探测统一使用单跳校验；探测不再递归，环形和嵌套路由在保存或探测时返回错误，不会栈溢出。 |
| G06 | P2 | Ctrl/Cmd+S 动作读取最新保存函数，连续编辑和视图重挂载不会捕获旧的 `dirty=false`；保存中重复触发受同步 busy 保护。 |
| G07 | P2 | 设置自动保存按字段记录编辑，基于最新 live 状态重基；明确清除的 Web 密码保持 `null`，等待 CCChan 保存后再次读取 live 状态，避免旧草稿复活凭据或覆盖宠物窗口状态。保存串行化，失败时可继续编辑或明确放弃并关闭。 |
| G08 | P2 | Git 冲突查询和 `git add` 使用 literal pathspec；文件名中的方括号、pathspec magic 等字符不会匹配或暂存其他冲突文件。 |
| G09 | P2 | Provider 创建入口统一限制 256 个新条目，并以最新磁盘配置判断容量。旧版本已经写入的超额但有效配置仍可读取、编辑和删除恢复，不会重启后静默清空凭据。 |

## 回归和完整验证

新增回归覆盖编辑 buffer 生命周期、外部文件刷新、快捷键闭包和并发保存、设置字段重基/失败关闭、SSH 链接与重名创建、daemon 丢响应、跳板环、Git literal pathspec、Provider 容量恢复。

| 检查 | 结果 |
| --- | --- |
| 前端完整测试 | 613 个文件，5925 项通过，0 失败 |
| Rust workspace 完整测试 | 2781 项通过，0 失败，2 项原有忽略；排除 4 条子进程夹具重复摘要 |
| 本轮前端定向回归 | 9 个文件，113 项通过 |
| 主线组合前端回归 | 5 个文件，56 项通过 |
| 主线组合严格 Clippy | 通过 |
| TypeScript | `tsc --noEmit` 通过 |
| Rust workspace 构建 | 通过 |
| 前端生产构建与 xterm 检查 | 通过 |
| 设计 token / 文案 / 主题对比度门禁 | 13 项设计门禁通过，主题对比度通过 |
| 性能脚本 / 发布资源测试 | 11 项 / 9 项通过 |
| 四个 debug 侧车 | 已重建并同步；三处 SHA256 一致 |

当前分支入口 gzip 为 883.6 kB，仍超过 880 kB 门禁，属于此前已知基线问题；主线组合临时副本的入口为 878.6 kB。分支严格 Clippy 仍会报告主线负责的 5 个既有 `dead_code`，主线组合严格 Clippy 通过。

## 主线兼容性

主线当前的 SettingsPanel 懒加载与本轮设置自动保存均保留。直接将完整补丁应用到主线工作区时，SettingsPanel 的相邻导入上下文会产生文本冲突；这是主线新增懒加载改动与本轮同一文件重构的预期重叠。已在主线当前源码的临时组合副本中手工保留懒加载边界，组合前端 56 项和严格 Clippy 均通过；主线工作区未被修改。

Windows 原生桌面行为、Windows 专属迁移和真实回收站删除仍需相应主机验证。macOS 完整 Rust 测试中的既有 Finder 回收站用例再次卡住；只终止了该测试创建的 osascript 辅助进程，测试随后走允许失败分支并验证链接目标未损坏。没有终止用户进程，也没有重启用户现有应用或 daemon。

- [最终验证清单](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-round4-fixes/manifest-final.json)
- [Rust 完整日志](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-round4-fixes/rust-full.log)
- [前端完整日志](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-round4-fixes/frontend-full.log)
- [主线组合 Clippy](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-round4-fixes/integrated-clippy.log)
- [主线组合前端](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-round4-fixes/integrated-frontend.log)
- [真实 SSH 修复复核](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-round4-fixes/sftp-fixed-manifest.json)

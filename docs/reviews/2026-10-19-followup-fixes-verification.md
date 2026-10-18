# dev0.12.22 后续六项修复验证

F01 至 F06 已修复，按三个 P1、三个 P2 的顺序提交在 `codex/fix-dev01222-deep-audit`。本轮验证的最终代码提交为 `8093cd61`，保留了此前八项修复；主线十五项修复以 `e8e71f7e` 为组合验证基准。

## 修复结果

| 编号 | 优先级 | 修复行为 |
| --- | --- | --- |
| F01 | P1 | 两个历史恢复入口共用路径校验。检查文件及已有祖先的物理路径，拒绝项目外链接、路径穿越和非法前缀；缺失文件也先检查祖先，再创建目录。 |
| F02 | P1 | 恢复前读取受影响文件的当前磁盘内容，绕过自动快照保存间隔，保存完整备份标签后再覆盖。备份错误阻止恢复；备份也记录原本不存在的文件。 |
| F03 | P1 | Runner 只有在冲突进程的 profile 与待启动 profile 相同时才建议 `KillSelfThenStart`；其他已知 profile 返回 `AskUserBeforeKill`。 |
| F04 | P2 | 版本清理与失效标签删除在同一事务内完成。任一引用版本过期，整个标签及其引用一起过期；有效标签、空标签保留。恢复先读取所有目标快照，缺失时返回错误，不再静默报告成功。 |
| F05 | P2 | 标签恢复遵循删除状态；显式“恢复已删除文件”仍恢复保存的内容。恢复后立即更新历史索引，因此关闭 watcher 或处于节流窗口时，已删除列表和新标签仍能反映恢复结果。 |
| F06 | P2 | 设置按界面字段归属重置：性能页重置会话优先级和 CPU 权重，保留终端外观；终端页重置保留这两个性能设置。 |

历史恢复与保留策略分别提取到 `history_service/restore.rs` 和 `history_file_repo/retention.rs`。同一历史仓库内的恢复、快照写入、压缩及清理通过文件操作锁协调；恢复使用原子文件替换，并保留已有文件的权限。

标签遵循历史保留策略，不是永久备份。已知路径或快照错误在写入工作文件前被拒绝；执行中发生磁盘写入错误会返回失败，恢复前标签保留供恢复已受影响的文件，不将多文件写入描述为文件系统事务。

## 回归与完整验证

新增 18 条 Rust、4 条前端回归测试，覆盖外部文件和父目录链接、非法路径、快照节流窗口、备份失败、缺失快照与 blob、删除及撤销恢复、恢复后索引、权限保留、三种保留策略、清理事务失败、跨项目 Runner 端口占用和两个设置页的重置范围。

| 检查 | 最终结果 |
| --- | --- |
| 前端完整测试 | 611 个文件，5907 项通过，0 失败 |
| Rust workspace 完整测试 | 2758 项通过，0 失败，2 项原有忽略；排除 4 条子进程夹具重复摘要 |
| TypeScript | `tsc --noEmit` 通过 |
| Rust 格式与 diff 空白检查 | 通过 |
| 前端生产构建与 xterm 检查 | 通过 |
| Rust workspace 构建 | 通过 |
| 性能脚本与发布元数据测试 | 分别 11 项、9 项通过 |
| 四个 debug 侧车 | 重建完成，工作区、构建目录、debug/binaries 三处 SHA256 一致 |
| 主线组合前端回归 | 5 个文件，29 项通过 |
| 主线组合 Rust 回归 | 18 项通过 |
| 主线组合严格 Clippy | `cargo clippy --workspace --locked -j 2 -- -D warnings` 通过 |
| 主线组合生产构建及包体预算 | 通过；入口 gzip 878.6 kB，预算 880 kB |

本分支单独运行严格 Clippy 仍遇到原审阅 R06 的 5 个 `dead_code` 错误；独立入口 gzip 为 883.8 kB，超过 880 kB 预算。这两处由主线既有修复覆盖，本轮没有复制主线修改或放宽检查，组合结果均通过。

macOS 的既有 `delete_entry_trash_dir_symlink_trailing_slash_keeps_target` 测试卡在 Finder。等待 79 秒后只终止了该测试创建的 osascript 子进程；测试随后通过“链接目标仍完整”的允许失败路径，未验证真实回收站删除成功。其余测试照常执行。Windows 专属路径和真实 Windows 桌面行为仍需 Windows 主机验证。

## 主线隔离与交付

本分支未修改主线工作区。`git merge-tree` 对本分支与 `e8e71f7e` 的组合检查无冲突；完整分支补丁在主线当前工作区的 `git apply --check` 也通过。`SettingsPanel.tsx` 中的字段重置修改与主线的懒加载修改已一起执行兼容测试。

组合验证使用临时源码副本，不纳入主线正在开发的其他未提交功能；验证后已删除临时副本，保留组合补丁与日志。没有重启用户正在使用的应用或 daemon。

- [验证清单](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-followup-fixes/manifest.json)
- [前端完整日志](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-followup-fixes/frontend-full.log)
- [Rust 完整日志](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-followup-fixes/rust-full.log)
- [组合严格 Clippy](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-followup-fixes/integrated-clippy.log)
- [补丁应用检查](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-followup-fixes/apply-to-current-main.log)
- [此前八项修复记录](2026-10-19-deep-fixes-verification.md)

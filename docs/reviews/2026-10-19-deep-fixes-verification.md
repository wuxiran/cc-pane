# dev0.12.22 补充审阅八项修复验证

补充审阅 D01 至 D08 已修复并补充回归测试。代码位于独立分支 `codex/fix-dev01222-deep-audit`，工作区为 `/Users/wuxiran/workspace/rust/cc-pane-deep-fixes`；基于 `05b90744`，验证的业务代码提交为 `540f6659`。建议整体合并该分支，包含后续补强的配置版本校验。

## 修复清单

| 编号 | 级别 | 最终行为与回归覆盖 |
| --- | --- | --- |
| D01 | P1 | 工作空间读改写通过 SQLite 写入预约锁跨进程序列化，JSON 原子替换；整份表单保存回传内容版本，拒绝过期快照并返回新版本。覆盖多实例 64 次写入、4 个进程 32 次写入、失败更新、过期表单及连续保存。 |
| D02 | P1 | 区分“快照替换保留进程”和“仍有 pinned 所有者”。保留订阅、session 状态、输入状态、可见性、弹窗及徽标；未被保留的分叉 leaf 仍正常回收。 |
| D03 | P1 | 历史重开改用统一项目身份规则，保留 SSH/WSL Linux 路径大小写。覆盖 `/srv/App` 与 `/srv/app` 同时存在及 WSL UNC 别名。 |
| D04 | P2 | SSH 启动不再触发本地历史初始化/自动标签；历史服务统一要求已存在的本机绝对目录，URI 和不存在的项目在写盘前被拒绝。 |
| D05 | P2 | 迁移通过同一套规范路径分量提取相对后缀，大小写差异不再回落为空路径。覆盖 Windows 盘符、跨表示形式、Unicode、WSL 大小写和真实子目录布局。 |
| D06 | P2 | 迁移解析已有祖先的物理路径，再追加未创建后缀；预览、执行和复制入口均拒绝目标位于源内部。覆盖符号链接、父目录分量、预览后别名改变。 |
| D07 | P2 | 前端 Windows 项目身份改为 ASCII 大小写折叠，与 Rust 一致。两端消费同一份 11 条 JSON 契约用例。 |
| D08 | P2 | 资源徽标接入 owner 销毁入口，仅当最后一个所有者消失才清理；覆盖关闭带 job-memory 告警的标签，及 pinned 副本仍存活的情况。 |

关键实现位置：

- [持久化写入锁](/Users/wuxiran/workspace/rust/cc-pane-deep-fixes/cc-panes-core/src/services/workspace_service/persistence.rs)、[工作空间更新与版本校验](/Users/wuxiran/workspace/rust/cc-pane-deep-fixes/cc-panes-core/src/services/workspace_service.rs)。
- [会话销毁管线](/Users/wuxiran/workspace/rust/cc-pane-deep-fixes/web/lib/tabLifecycle/destroyPipeline.ts)、[跨布局所有者清理](/Users/wuxiran/workspace/rust/cc-pane-deep-fixes/web/stores/paneRemovalActions.ts)。
- [迁移路径规则](/Users/wuxiran/workspace/rust/cc-pane-deep-fixes/cc-panes-core/src/services/workspace_service/migration_paths.rs)、[共享身份契约](/Users/wuxiran/workspace/rust/cc-pane-deep-fixes/cc-panes-core/tests/fixtures/project_identity.json)。

配置版本是读取时计算的传输元数据，不需要迁移已有 workspace.json。新版界面会携带版本并刷新冲突数据；旧客户端显式省略版本时，保留完整替换的兼容行为。服务内部的读改写调用已统一放入写入锁，包括启动配置绑定。

## 最终验证

| 检查 | 结果 |
| --- | --- |
| 前端完整测试 | 609 个文件，5903 项通过 |
| Rust workspace 完整测试 | 2740 项通过，0 失败，2 项忽略；未重复计入 4 个子进程夹具自身的摘要 |
| Web 资源路由补验 | 8 项通过，验证完整保存返回新版本 |
| TypeScript | 通过 |
| 前端生产构建与 xterm 契约 | 通过 |
| Rust workspace 构建 | 通过 |
| 格式与 diff 空白检查 | 通过 |
| 性能脚本测试 | 11 项通过 |
| 发布元数据测试 | 9 项通过 |
| 本分支严格 Clippy | 被原审阅 R06 的 5 个既有 dead_code 错误阻塞，未重复修改主线负责的文件 |
| 与主线补丁组合后的严格 Clippy | `cargo clippy --workspace --locked -j 2 -- -D warnings` 通过 |
| 包体预算 | 入口 gzip 883.7 KiB，仍高于 880 KiB；与审阅基线相同，未放宽预算 |

Rust 完整测试中的 `delete_entry_trash_dir_symlink_trailing_slash_keeps_target` 再次卡在 Finder 的 osascript。只终止本轮测试创建的临时链接辅助进程后，用例通过“链接目标仍完整”的允许失败分支。真实回收站删除未验证成功；没有因此跳过其他测试或改动该用例。

新增 Windows 专属真实迁移回归已提交，但本轮宿主为 macOS，没有执行 Windows 专属代码路径。Windows 路径算法的跨平台用例已通过。

## 与主线十五项修复的隔离

- 主线工作区为 `/Users/wuxiran/workspace/rust/cc-pane-audit-fixes`，本分支未修改它。
- 最终核对时，两侧修改的业务源码文件没有重叠，本分支补丁在主线当前工作区 `git apply --check` 通过。
- 资源徽标存储由主线修改，本分支只调用既有 `clearResource` API。主线存储实现与本分支生命周期代码在临时副本中组合，3 项兼容回归通过。
- 主线未提交补丁与本分支组合后的完整 Rust 严格 Clippy 通过。集成副本用于验证，未把主线十五项的修改纳入本分支提交。
- 四个 debug 侧车已重建，并同步到本分支资源目录及独立构建目录；逐一核对 SHA256 一致。没有重启用户现有应用或 daemon。

## 验证证据

[验证清单](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-deep-fixes/manifest.json)、[前端完整日志](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-deep-fixes/frontend-full.log)、[Rust 完整日志](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-deep-fixes/rust-full.log)、[集成 Clippy](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-deep-fixes/integrated-clippy.log)、[主线兼容测试](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-deep-fixes/compatibility-tests.log)、[补丁应用检查](/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-19-deep-fixes/apply-to-main.log)。同目录保留构建、类型检查、侧车校验及测试环境说明。

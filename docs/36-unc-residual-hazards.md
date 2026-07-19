# UNC 收尾：文件树与 daemon/web 的两处同源隐患

> 状态：待实施 | 前置：`docs/35-unc-path-contamination.md`（已完成）

## ⚠️ 约束

**只许碰**：

- `cc-panes-core/src/services/filesystem_service.rs`
- `cc-panes-daemon/src/main.rs`
- `cc-panes-web/src/main.rs`
- 对应测试

**不要碰**：`web/` 下任何文件、`cc-panes-cli-hook/`、
`cc-panes-core/src/repository/`、`cc-panes-core/src/services/terminal_service.rs`、
`src-tauri/src/services/orchestrator_service.rs`（`docs/35` 已改完，不要重复动）。
**禁止任何 git 写操作**（工作树里有十二个主题的未提交成果）。

## 背景

`docs/35` 已修掉主链路（CLI hook → history_repo → launchHistory → PTY cwd）
并提供了统一入口 `cc-panes-core/src/utils/path_normalize.rs`
（`simplify_path` / `simplify_path_str` / `simplify_opt_path_str`，
全部委托 `dunce`，非 Windows 天然 no-op）。

排查时确认了两处**同源但独立**的隐患，本任务收掉。

## 隐患 1：文件树吐 `\\?\` 路径

`cc-panes-core/src/services/filesystem_service.rs:30-34` 的 `validate_path`
返回 `canonicalize()` 后的路径，因此 `list_directory`（`:325`）与
`entry_from_path`（`:269`）把带 `\\?\` 前缀的 path 交给前端文件树。

**当前无用户可见故障**（文件树只做展示与读写，不作为 PTY cwd），
但**将来做「文件树右键在此打开终端」时会立刻复现 `docs/35` 那个崩法**。

`web/components/filetree/FileTreeContextMenu.tsx:198` 已存在
「在此打开终端」入口——需确认它当前拿到的 path 是否来自 `list_directory`。
**若确实已在触发链路上，那这不是隐患而是现存 bug，请在汇报里明确指出。**

**改法**：`validate_path` 返回前经 `simplify_path`。

⚠️ **注意边界检查语义**：`validate_path` 的 canonicalize 同时承担
**路径边界校验**（防 `..` 逃逸）。剥前缀只能发生在**校验通过之后**，
不得改变校验逻辑本身。同文件 `:76-94` 有关于符号链接处理的精细注释
（"仅规范化父目录，既维持路径边界检查，也允许删除悬空链接"），
动手前先读懂，不要破坏。

## 隐患 2：daemon / web 的 `default_cwd`

- `cc-panes-daemon/src/main.rs:216`
- `cc-panes-web/src/main.rs:212`

两处都对 `args.cwd` 做了 `canonicalize()`。请求缺 `project_path` 时会回落到该值：

- `cc-panes-daemon/src/server.rs:431`
- `cc-panes-web/src/routes/terminal.rs:139`

**这条路是活的**——用户 dev 实例 `daemonEnabled = true`。

**改法**：改用 `dunce::canonicalize`，或 canonicalize 后经 `simplify_path`。

⚠️ 这两个 crate 是否已依赖 `cc-panes-core` / `dunce`？
`docs/35` 只给 `cc-panes-core` 与 `cc-panes-cli-hook` 加了 `dunce` 直接依赖。
若 daemon/web 已依赖 core，直接用 `path_normalize` 的函数；
否则加 `dunce` 直接依赖。**不要为一个路径函数引入不必要的重依赖**
（`docs/35` 的 worker 正是因为这个理由才选的 dunce）。

## 验收

- `cargo check --workspace`
- `cargo clippy --workspace -- -D warnings`
- `cargo test -p cc-panes-core`（`cargo test --workspace` 可能被运行中的
  daemon 进程文件锁阻塞——**不要杀用户的进程**，改用分 crate 测试，
  并在汇报里说明哪些没跑到）
- 补测试：`validate_path` 返回值不含 `\\?\`；边界校验行为不变
- **非 Windows 平台必须 no-op**

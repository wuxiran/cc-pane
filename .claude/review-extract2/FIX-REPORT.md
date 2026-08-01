# OpenCode 会话反查修复报告

日期：2026-08-02

工作目录：`/mnt/d/04_workspace_rust/cc-book-merge`

基线：`8171692`（包含 `ade2050`）

提交：未提交

## 已修复

### #4 项目过滤发生在全局 LIMIT 之后

- `cc-panes-core/src/services/opencode_session_service.rs:212`：本地 OpenCode 查询统一进入 `query_sessions_from_db`，项目路径条件和检测时间条件都在 SQL `WHERE` 中执行，排序后才应用 `LIMIT`。
- `cc-panes-core/src/services/opencode_session_service.rs:356`：WSL 扫描把路径过滤器和时间边界序列化给 WSL 内 Python，并注册只负责候选匹配的 SQLite 函数；SQLite 先过滤项目再排序和 LIMIT。
- `cc-panes-core/src/services/opencode_session_service.rs:659`、`:709`：新增回归测试，分别构造超过旧 `limit * 4` 和固定 500 条扫描窗口的其他项目会话，确认目标项目不会再被挤掉。

原因：扩大全局扫描窗口不能保证目标项目出现；项目活跃度是跨项目分布，必须在数据库查询阶段限定项目。

### #6 POSIX 路径被无条件转小写

- `cc-panes-core/src/services/opencode_session_service.rs:42`：路径候选复用 Codex 的跨 Windows/WSL POSIX 映射，同时以 `canonical_project_path` / `project_identity_key` 决定大小写语义；Windows 盘符及 `/mnt/<drive>` 不敏感，普通 POSIX、WSL Linux 路径和普通 UNC 保持敏感。
- `cc-panes-core/src/services/opencode_session_service.rs:697`：新增 `/home/dev/Repo` 与 `/home/dev/repo` 不等的回归测试；同文件另有 Windows 盘符和 WSL UNC 等价测试。

原因：不能把 Codex 对未知路径的 lowercase 兜底扩散成新的通用判等规则。

### #5 MCP `list_resume_sessions` 不支持 OpenCode

- `src-tauri/src/services/orchestrator_service.rs:6191`：工具说明更新为 Claude/Codex/OpenCode。
- `src-tauri/src/services/orchestrator_service.rs:6261`：加入 OpenCode 本地和 WSL 查询分支，返回 `sessionId`、`projectPath`、`modifiedAt`、`description`、`cliTool`、`runtimeKind` 和 `wslDistro`。
- 同文件 `:2928`、`:2967`、`:3017`、`:3120`、`:3158`、`:7853` 同步更新 Claude/Codex-only 的参数和 resume 注释。

原因：`launch_task(cliTool="opencode")` 已能启动和恢复，查询工具必须返回可用于恢复的 OpenCode session id。

### #9 `terminalBufferMode` 漏 OpenCode

- `web/components/panes/terminalBufferMode.ts:139`：`NORMAL_BUFFER_CLI_TOOLS` 加入 `opencode`。
- `web/components/panes/terminalBufferMode.test.ts:25`：在 main 现有完整测试集上增加 OpenCode 断言，没有用旧分支测试覆盖现有用例。

原因：OpenCode 同样是全屏 TUI，需剥离 alternate-buffer 切换序列以保留主缓冲历史。

### #10 HTTP limit 未封顶且 SQLite 转换可能为负

- `cc-panes-web/src/routes/agent_sessions.rs:15`：Claude、Codex、OpenCode 项目会话路由以及 Claude 全局路由统一封顶为 100，保留 `limit=0` 语义。
- `cc-panes-core/src/services/opencode_session_service.rs:69`：使用 `i64::try_from(limit).unwrap_or(i64::MAX)`，不再通过 `usize as i64` 产生负 LIMIT。
- `cc-panes-web/src/routes/agent_sessions_tests.rs:78`、`cc-panes-core/src/services/opencode_session_service.rs:720`：覆盖 HTTP 超大值封顶和 SQLite LIMIT 非负。

原因：SQLite 的负 LIMIT 表示不限量，不能让超大 HTTP 输入触发全库扫描。

## 判断后未修

### #7 侧栏编排器默认 OpenCode 降为 Claude

结论：不影响本次会话反查能力，登记为独立 OpenCode 功能对等项。

证据：`web/components/sidebar/OrchestratorInput.tsx:15` 的选择项仍只有 Claude/Codex，`:41`、`:71` 会把其他默认值回落为 Claude；但 `list_resume_sessions` 接受显式 `cliTool="opencode"`，查询已有 OpenCode 会话不经过该组件。

独立影响：用户不能从侧栏编排输入直接选择 OpenCode，且全局默认 OpenCode 在该入口会显示/创建为 Claude。

### #8 工作空间 per-CLI 默认环境缺 OpenCode

结论：不影响本次会话反查能力，登记为独立 OpenCode 功能对等项。

证据：`cc-panes-core/src/models/workspace.rs:18` 只有 Claude/Codex 字段，`web/utils/workspaceLaunch.ts:103` 也只解析两者；但反查由调用方显式传入 `runtimeKind/wslDistro`，已有启动历史和标签的实际运行时信息不依赖该默认字段。

独立影响：OpenCode 新启动不能配置工作空间级 per-CLI 环境覆盖，只能走显式运行时或工作空间通用默认。

### #11 WSL 扫描无超时

结论：未修，登记为既有跨 CLI 问题。

证据：`cc-panes-core/src/services/codex_session_service.rs:563` 的 Codex WSL 会话扫描同样直接调用 `.output()`，`codex_session_service` 内没有现成超时机制可复用。按 FIX-PLAN 边界，本轮不单独给 OpenCode 引入另一套进程超时实现。

影响：Windows 上 WSL 发行版或其 Python/SQLite 调用卡住时，Codex/OpenCode 会话查询仍可能无限等待。需要后续统一修复两条扫描链路，并验证子进程终止与输出回收。

## 验证结果

1. `npx tsc --noEmit && echo "EXIT=$?"`
   - 通过，输出 `EXIT=0`。
2. `cargo clippy --workspace -- -D warnings`
   - 首次失败：本轮重构后 `chrono::Utc` 只在测试使用，且测试辅助函数在非测试构建中为 dead code。
   - 修复为测试内导入和 `#[cfg(test)]` 后原命令重跑通过；`Finished dev profile`，退出码 0。
3. `cargo test --manifest-path src-tauri/Cargo.toml`
   - 通过。库单测 275/275；history 15/15、project 3/3、start-runner 1/1、workspace 13/13、workspace migration 5/5；0 失败。
4. `cargo test -p cc-panes-core`
   - 通过。库测试 878 通过、1 忽略；后续集成和文档测试全部通过。
   - 出现既有警告：`cc-panes-core/src/services/session_restore_service.rs:473` 有重复 `#[test]` 属性；不在本次范围。
5. `npx vitest run --maxWorkers=3 web/services web/components/panes`
   - 首次未进入测试：缺少锁文件已声明的 `@rollup/rollup-linux-x64-gnu@4.60.1` 可选依赖，退出码 1。
   - 使用 `--no-save --package-lock=false` 补齐 `node_modules` 后，确认 `package.json`、`package-lock.json` 无变化；原命令重跑通过：89 个测试文件、713 个测试，0 失败，耗时 911.51 秒。

## 边界与残余风险

- `git diff --check` 通过；最终只有本报告和 6 个目标代码/测试文件存在本轮差异。
- 没有提交 Git。
- 当前环境为 WSL/Linux；Windows 宿主的 `wsl.exe` 扫描脚本没有实机运行，Windows 侧超时问题也仍按 #11 保留。Linux Clippy/测试不能替代 Windows 运行时验收。

# review-0118 修复报告

日期：2026-08-01

本报告只覆盖 `FIX-PLAN.md` 规定的四组 P1 修复，以及 #7 / #9 的待验标注。未提交 Git；工作树中原有的无关修改和未跟踪文件均保留，未清理、未暂存、未回退。

## 1. leaf 级 launch identity

### 改了什么

- `TerminalPaneLeaf` 增加可选 `launchId`，新 leaf、分屏克隆和旧快照迁移都会为 leaf 建立自己的 launch identity；旧快照缺字段时按需补齐，不阻断 rehydrate。
- `TerminalTabContent` 改为把 `leaf.launchId` 传入 `TerminalView`，不再把稳定 tab/project id 当成本次 PTY 的 launch id。
- `TerminalView` 的初始化恢复和隐藏布局激活恢复都在真正创建 PTY 前生成新的 one-shot launch id，并先写回对应 leaf；普通启动、后台恢复、重试、移动端入口和 orchestrator 重试入口也统一携带独立 launch id。
- popup / self-chat 只 attach 既有 PTY，不再误传稳定 id 参与新会话绑定。

### 为什么

稳定 tab id、conversation resume id 和一次性 launch id 的生命周期不同。复用旧 launch id 会命中上一次已绑定的历史行，使新 PTY 无法绑定，分屏 leaf 还会互相覆盖。每次真实创建 PTY 使用新 id 后，一条 launch_history 行只归属一次启动。

### 主要文件与行号

- `web/types/terminal.ts:98`、`web/stores/panesStoreTypes.ts:25`：leaf / tab 参数模型增加 `launchId`。
- `web/stores/paneTreeHelpers.ts:18`、`web/stores/usePanesStore.ts:164`：新建与克隆 leaf 生成新 id。
- `web/stores/usePanesStore.ts:858`、`web/stores/usePanesStore.ts:3045`：旧快照兼容迁移。
- `web/stores/usePanesStore.ts:1852`：按 tab + leaf 写回 launch id。
- `web/components/panes/TerminalTabContent.tsx:166`：向 `TerminalView` 传 leaf id。
- `web/components/panes/TerminalView.tsx:252`、`web/components/panes/TerminalView.tsx:1662`、`web/components/panes/TerminalView.tsx:2095`：初始化 / 恢复 / 激活创建 PTY 前轮换 id。
- `web/hooks/useOpenTerminal.ts:47`、`web/hooks/backgroundLayoutRestore.ts:72`、`web/stores/usePanesStore.ts:2538`：普通、后台和 store 直建路径生成独立 id。
- `web/components/sidebar/OrchestratorTaskActions.tsx:179`、`web/components/layout/MobilePrototypeRoute.tsx:65`：其他真实建 PTY / 启动入口携带同一条 one-shot id。

## 2. 写入原子化与来源仲裁

### 改了什么

- `upsert_session_started` 的查询、PTY 归属检查、CLI 冲突检查、resume source 仲裁、UPDATE / INSERT 和最终提交放进同一 SQLite 事务。
- 返回 `SessionStartedUpsertResult`，调用方拿到数据库最终选中的 resume id / source，不再把被仲裁拒绝的传入值当成成功结果。
- 缺行兜底 `upsert_missing_row` 统一调用上述事务入口；CLI 缺失时只按 UUID 版本推断，CLI 冲突直接拒绝，低优先级 `rollout-scan` 不能覆盖 `issued`。
- 新增 v29 迁移：确定性保留同一 `project_id` 最新行，删除历史重复，再建立 `UNIQUE(project_id)` 索引。
- v29 对事故型残缺库容错：如果版本记录已到 v27 但 `launch_history` 整表缺失，先按当前 schema `CREATE TABLE IF NOT EXISTS`，再执行去重和索引，避免迁移链报错导致应用无法启动。

### 为什么

只加唯一索引不能解决 leaf 共用 identity，也不能防止并发 read-update 期间来源降级。事务把 PTY ownership、CLI 兼容性和 source 选择变成一个原子决定；v29 的缺表自愈则覆盖仓库已真实出现过的截断 schema 风险。

### 主要文件与行号

- `cc-panes-core/src/repository/history_repo.rs:36`：最终仲裁结果类型。
- `cc-panes-core/src/repository/history_repo.rs:540`：事务 upsert 主体。
- `cc-panes-core/src/repository/history_repo.rs:583`：PTY / CLI 冲突防线。
- `cc-panes-core/src/repository/history_repo.rs:603`：复用统一 source 仲裁规则。
- `cc-panes-core/src/repository/history_repo.rs:672`、`cc-panes-core/src/repository/history_repo.rs:708`：UPDATE / INSERT 分支仅在完成后提交并返回最终值。
- `src-tauri/src/services/resume_binding_service.rs:218`：缺行兜底改走统一事务入口。
- `src-tauri/src/services/resume_binding_service.rs:440`：`issued` 防 `rollout-scan` 降级与 CLI 冲突回归测试。
- `cc-panes-core/src/repository/db.rs:653`：v29 缺表自愈、去重与唯一索引。
- `cc-panes-core/src/repository/db.rs:1053`、`cc-panes-core/src/repository/db.rs:1110`：残缺 schema 与重复 launch id 迁移测试。

## 3. A3 恢复报告口径

### 改了什么

- 报告从 tab 级改为遍历 terminal leaf；split tab 不再只统计 active leaf。
- `cliTool === "none"` 固定归为 `shell` 并从 agent 总数、with/without resume id 统计中排除。
- 明确区分 `adopted`、`resumed`、`fresh`、`shell`；只有 `resumed && !hasResumeId` 计入 `missingResumeId` 并触发回归告警。热接管但无 resume id 的 adopted leaf 不误报。
- 启动报告等待 terminal restore barrier 后再采样，避免把稍后会被 daemon 热接管的 leaf 提前误判。
- 增加可见 Banner、一次性 store、中英文文案，以及 split leaf / 全纯 shell / dismissed 等测试。

### 为什么

纯 shell 没有 conversation resume 语义；fresh 本来就是新会话；adopted 已接管原 PTY。把这些都算作“丢失 resume id”会稳定误报。真正的回归口径只能是本次明确走 resumed 恢复但 id 缺失的 agent leaf。

split fixture 的正确结果是 `withResumeId: 1`、`withoutResumeId: 1`、`missingResumeId: 0`：未绑定的那条是 adopted leaf，不是恢复失败。

### 主要文件与行号

- `web/utils/restoreReport.ts:32`：按 leaf 收集恢复条目。
- `web/utils/restoreReport.ts:46`：shell / adopted / resumed / fresh 分类。
- `web/utils/restoreReport.ts:79`：排除 shell，并只统计真正缺失的 resumed leaf。
- `web/hooks/useAppLifecycleLate.ts:59`：等待恢复屏障后写报告和告警 store。
- `web/components/RestoreRegressionBanner.tsx:16`、`web/stores/useRestoreReportStore.ts:21`：可见告警及启动期状态。
- `web/components/RestoreRegressionBanner.test.tsx:67`、`web/components/RestoreRegressionBanner.test.tsx:80`：全 shell 不报警与 split leaf 口径测试。

## 4. daemon 换代

### 改了什么

- 换代判定同时检查 `session_count` 和 `desktop_client_count`；当前实例的控制 WS 是否已连接用于从总 client 数中排除自己。存在会话或其他桌面实例时都延后换代。
- 旧 daemon 缺 `desktopClientCount` 时保持兼容，降级使用原 session-only 判据。
- 启动时因会话存活而 defer 后，每次后续真实创建 PTY 前重新评估；这样最后一条旧会话结束后，无需等待控制链重连也能在下一次创建前完成换代。
- `daemon_upgrade_lock` 串行化 retire / wait / start，等待者会重新读取当前 client，避免并发创建 PTY 时重复关闭或重复启动 daemon。
- 旧 daemon shutdown 后必须确认 health 失效再启动 replacement。注释已订正：daemon 使用随机端口，端口冲突不会阻止双实例。

### 为什么

仅看 session 数会误伤正在共享 daemon 的另一个桌面实例；只在启动 / 重连时检查则可能永远停留在旧 daemon；随机端口也不能提供互斥保证。client 计数、创建前重检、进程退出确认和本地串行锁共同缩小换代竞态。

### 主要文件与行号

- `src-tauri/src/services/terminal_daemon_lifecycle.rs:93`：创建 PTY 前重检入口。
- `src-tauri/src/services/terminal_daemon_lifecycle.rs:135`、`src-tauri/src/services/terminal_daemon_lifecycle.rs:160`：读取两类计数并决定是否换代。
- `src-tauri/src/services/terminal_daemon_lifecycle.rs:198`：retire / wait / start 顺序。
- `src-tauri/src/services/terminal_backend_state.rs:15`、`src-tauri/src/services/terminal_backend_state.rs:197`：换代锁及创建前串行重检。
- `src-tauri/src/services/terminal_daemon_control_link.rs:31`、`src-tauri/src/services/terminal_daemon_control_link.rs:55`：记录当前 desktop 控制连接状态。
- `src-tauri/src/services/terminal_daemon_lifecycle.rs:404`：换代边界回归测试。

## 本轮未修：#7 / #9 Windows 待验

### #7 mtime 判据

未修改判据，只在 `src-tauri/src/services/terminal_daemon_lifecycle.rs:125` 标注待 Windows 实测。

建议在 Windows 安装包环境分别验证：

1. 更新前记录 daemon `startedAt` 和磁盘 exe `LastWriteTime`。
2. 覆盖安装器保留 mtime、刷新 mtime、系统时钟回拨、同版本重装四种情形。
3. 分别保持“有 PTY”“无 PTY但另一桌面实例连接”“完全 idle 且 unshared”，核对只在最后一种情况下换代。
4. 核对换代后 manifest、PID、二进制路径和现存 PTY 连续性。

### #9 卸载漏杀已改名 daemon

未猜测修改卸载匹配逻辑，只在 `src-tauri/nsis/installer-hooks.nsh:39` 标注待 Windows 实测。

建议在 Windows 安装包环境：先执行一次更新，让运行中的 daemon 被改名为 `cc-panes-daemon.exe.<stamp>.old`；保持其子 PTY / CLI 进程存活后直接卸载；用 CIM 或 Process Explorer 核对已改名 daemon 及整棵子进程树是否被终止，并检查安装目录 `binaries` 残留。静默卸载还要确认用户数据保留策略未被改变。

## 验证结果

FIX-PLAN 五条命令的原始结果（前三条由用户在本轮收口前独立执行）：

1. `npx tsc --noEmit`：退出码 0。
2. `cargo clippy --workspace -- -D warnings`：退出码 0。
3. `cargo test --manifest-path src-tauri/Cargo.toml`：`280 + 15 + 3 + 1 + 13` 全部通过。
4. `cargo test -p cc-panes-core`：修复前为 889 passed / 1 failed，失败点是 v29 对缺失 `launch_history` 执行 DELETE；补齐缺表自愈后完整重跑通过（lib 870 passed / 0 failed / 1 ignored，integration 6 + 8 + 3 通过）。本次收口又定点执行 `repository::db::tests::migration_28_repairs_truncated_provenance_table -- --exact`：1 passed，退出码 0。
5. 前端 Vitest：修复前 675 passed / 1 failed；按用户要求用相关目录替代超过 10 分钟的完整运行，修复后共 676 passed：
   - `web/components/RestoreRegressionBanner.test.tsx`：8 passed。
   - `web/utils`：首次 162 个断言通过但 3 个 fork worker 启动超时，退出码 1；原样重跑 17 files / 188 tests 全通过，退出码 0，按高负载假失败处理。
   - Windows 宿主 `web/hooks`：20 files / 151 tests 全通过，退出码 0。
   - Windows 宿主 `web/components/panes`：42 files / 329 tests 全通过，退出码 0。

额外检查：`git diff --check` 退出码 0；仅输出两个现有 i18n JSON 工作副本的 CRLF -> LF 提示，无 whitespace error。

## 交付状态

- 未执行 Windows Tauri 桌面运行、安装器更新或卸载验收；#7 / #9 仍明确为 Windows-host-required。
- 未提交、未暂存、未 push Git。
- 未清理或改写与本次范围无关的工作树脏改动。

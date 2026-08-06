# 0113-orch-lifecycle Worker Report

## 1. 状态

IMPLEMENTED

提交：

- `0a3f79f feat(orchestrator): expose binding lifecycle and retries`
- `637474a feat(orchestrator): show startup failure alerts`

未 push，未修改规格 `docs/57-ccpanes-ctl-and-mcp-orphan.md`。

## 2. 实现与关键位置

- `src-tauri/src/services/orchestrator_service.rs:1225`：定义状态事件、5 次/15 秒有界退避常量。
- `src-tauri/src/services/orchestrator_service.rs:1235`：新增 `binding | ready | failed` lifecycle 与完整 `OrchestratorStatus`。
- `src-tauri/src/services/orchestrator_service.rs:1326`：可由退出信号立即打断的重试等待。
- `src-tauri/src/services/orchestrator_service.rs:1446`、`src-tauri/src/lib.rs:2568`：应用退出时取消绑定重试并触发 server graceful shutdown。
- `src-tauri/src/services/orchestrator_service.rs:1532`：原子 guard 保证同一 service 最多一个绑定循环。
- `src-tauri/src/services/orchestrator_service.rs:1924`：ready 后清空 `attempt`/`lastError`/`nextRetryAt`，并在异步 ready 点写 TerminalService endpoint 与 manifest。
- `src-tauri/src/commands/orchestrator_commands.rs:17`：现有状态命令返回完整生命周期快照。
- `web/types/settings.ts:259`：Rust -> TS lifecycle/status 类型同步。
- `web/services/mcpService.ts:67`、`web/hooks/useOrchestratorStatus.ts:5`：事件订阅与首次状态读取。
- `web/components/OrchestratorAlertBanner.tsx:14`、`web/components/layout/AppShell.tsx:41`：全局重试/失败横幅、MCP 影响和逃生阀指引。
- `web/components/settings/WebAccessSection.tsx:353`：设置页回访入口显示 lifecycle、attempt、nextRetryAt、lastError。

## 3. 未做到或未验证

- 未在 Windows 宿主实际占用 47822/47821 并启动桌面应用；WSL 不能证明 WebView2、Windows socket 与桌面横幅的宿主行为。
- 未运行 `cargo test --workspace`，遵守任务禁止项，避免 daemon 文件锁阻塞。
- 未 push、未合并 main。
- 未发现未实现的规格项。

Windows 宿主人工验证步骤：

1. Dev 用 PowerShell 占用 47822（release 改 47821）：`$l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Any, 47822); $l.Start()`。
2. 启动对应 CC-Panes，确认横幅先显示重试 attempt/nextRetryAt，设置页显示 lifecycle 与 lastError。
3. 在 15 秒有界重试耗尽前执行 `$l.Stop()`，确认状态恢复 ready、横幅消失、设置页清空 attempt/lastError。
4. 再次占用端口并让 5 次尝试全部耗尽，确认 failed 横幅持续可见，包含 CLI MCP 不可用说明与 `CC_PANES_ORCHESTRATOR_PORT` 指引。
5. 重试等待中退出应用，确认进程退出后没有遗留绑定重试线程。

## 4. 验证结果

- `cargo clippy --workspace -- -D warnings ; echo "EXIT=${PIPESTATUS[0]}"`：`EXIT=0`。
- `cargo fmt --all -- --check`：退出码 0。
- `cargo test -p cc-panes --lib orchestrator`：退出码 0，87 passed / 0 failed / 157 filtered out。
- `npx tsc --noEmit`：退出码 0。
- `npx vitest run web/test/i18nParity.test.ts web/test/noRawText.test.ts web/components/designTokens.test.ts web/services/mcpService.test.ts web/hooks/useOrchestratorStatus.test.tsx web/components/OrchestratorAlertBanner.test.tsx web/components/settings/WebAccessSection.test.tsx --maxWorkers=1 --no-fileParallelism`：退出码 0，7 files / 31 tests passed。
- `git diff --check` 与两次提交前 `git diff --cached --check`：退出码 0。

## 5. 获取方式选择

选择事件 emit，不使用轮询。绑定生命周期只在启动与有限次重试时变化，常驻轮询没有必要；Rust 每次状态跃迁 emit `orchestrator-status-changed`，前端先订阅事件再调用一次 `get_orchestrator_status` 读取快照，既避免常驻开销，也覆盖 WebView 挂载前已经发生的状态变化。Hook 还防止较晚返回的首次快照覆盖更新的事件状态。

## 6. 并行冲突清单

- 触碰 `web/components/layout/AppShell.tsx`：仅 2 行（1 行 import + 1 行独立横幅挂载）。
- 未触碰 `cc-panes-core/src/models/settings.rs`。
- 未触碰 `web/components/settings/GeneralSection.tsx`。
- 未触碰 `web/components/settings/SettingsPaneContent.tsx`。
- 未触碰 `web/components/StatusBar.tsx`。

ORCH-TASK-COMPLETE

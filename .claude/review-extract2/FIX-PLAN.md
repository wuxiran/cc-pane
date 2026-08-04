# 修复交接件 · 依据你自己的 OpenCode 评审

你上一轮评审的 11 条我抽检了 3 条，**全部成立**（含我一度以为不成立的 #9 ——
我查错了分支，`feat/opencode-parity` 上确实是 `["claude","codex","opencode"]`）。

现在请你**实施修复**。这一轮你可以改代码。

## 必修（真 bug + 漏抽）

### 1. #4 先全局 LIMIT 再按项目过滤（最高优先级）

`cc-panes-core/src/services/opencode_session_service.rs:277`
`list_sessions` 调 `list_all_sessions(limit*4)` 取全局最新 N 条，再在内存里按项目过滤。
别的项目活跃时，目标项目即使有历史也稳定返回空。`detect_session` 固定取全局 500 条同理。

**改法自定**，但要求：过滤下推到 SQL（`WHERE project.path = ?` 或等价），
不要靠放大 limit 掩盖。注意 `project_path` 的匹配语义要和下面 #6 一致。

### 2. #6 POSIX 路径无条件转小写

`opencode_session_service.rs:36`。与 Codex 的大小写敏感语义不一致，
`/home/dev/Repo` 与 `/home/dev/repo` 会被当成同一项目。

注意 CLAUDE.md 的既有约定：路径判等要过 `canonical_project_path` 语义
（Windows 不敏感、POSIX 敏感）。请对齐 `codex_session_service` 的现有做法，
不要自创一套。

### 3. #5 MCP `list_resume_sessions` 拒绝 opencode

`src-tauri/src/services/orchestrator_service.rs:6191`、`:6261`。
`launch_task(cliTool="opencode")` 能启动能恢复，但同一个 MCP 查不到 resume id。
文档注释「查询指定 CLI 的历史会话列表（Claude/Codex）」也要一并更新。

### 4. #9 `terminalBufferMode` 漏 opencode

`web/components/panes/terminalBufferMode.ts:138` 的 `NORMAL_BUFFER_CLI_TOOLS`。
`feat/opencode-parity` 上是 `["claude","codex","opencode"]`，抽取时漏了。
该分支有对应测试，一并带过来（**但要核对测试是否依赖分支上其他已被 main 取代的东西**）。

### 5. #10 limit 未封顶 + `usize as i64` 可为负

`cc-panes-web/src/routes/agent_sessions.rs:75`、`opencode_session_service.rs:237`。
负 LIMIT 在 SQLite 表示不限，会扫全库。请封顶并防负。
**顺带核对 codex/claude 那两条路由有没有同样问题**——有的话一并修，别只修 opencode。

### 6. #11 WSL 扫描无超时

`opencode_session_service.rs:415` 同步跑 `wsl.exe` 无超时，发行版卡住时请求无限等待。
请查 `codex_session_service` 的 WSL 调用是否已有超时机制，有就复用，没有就说明现状
（那样属于既有问题，不在本次范围，登记即可）。

## 需要你先判断再决定做不做

### #7 侧栏编排器把默认 OpenCode 降为 Claude
`web/components/sidebar/OrchestratorInput.tsx:15`、`:41`

### #8 工作空间 per-CLI 运行环境缺 OpenCode 字段
`cc-panes-core/src/models/workspace.rs:18`、`web/utils/workspaceLaunch.ts:103`

这两条都属于「OpenCode 功能对等」的更大范围，不是本次「补上会话反查」的直接后果。
**请先判断**：它们是否会让本次新增的会话反查能力实际不可用？
- 是 → 修，并说明因果
- 否 → 不修，登记为独立后续项，写清影响

不要因为「旧分支里有」就照搬——那条分支整体已被 main 取代。

## 纪律

- 改动过程中**不要跑测试**，最后一次性跑：
  ```
  npx tsc --noEmit && echo "EXIT=$?"
  cargo clippy --workspace -- -D warnings     # 不加 | tail，会掩码退出码
  cargo test --manifest-path src-tauri/Cargo.toml
  cargo test -p cc-panes-core
  npx vitest run --maxWorkers=3 web/services web/components/panes
  ```
- **cargo 不要并发跑**：多个 worktree 共享同一个 target-dir，并发会互相踩构建产物，
  报出源码里不存在的编译错误（我本轮踩过，串行即消失）。
- 工作目录用 `/mnt/d/04_workspace_rust/cc-book-merge`（当前 main，已含被评审的 `ade2050`）。
- 完整 `npx vitest run` 本机会超 10 分钟超时，跑相关目录即可；高负载偶发假失败，重跑再判。
- **不要提交 git**，不要碰工作树里与本次无关的改动。
- 遵守 CLAUDE.md 的编码规范；改动处写清 why。

## 完成后

写 `.claude/review-extract2/FIX-REPORT.md`：每条改了什么、为什么、文件行号；
#7/#8 的判断结论与理由；未修项写清原因；测试结果如实贴（失败就贴失败）。

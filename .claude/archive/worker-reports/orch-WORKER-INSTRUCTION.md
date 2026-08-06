# Worker 任务：orchestrator 绑定可观测性（0113-orch-lifecycle）

## 一句话

orchestrator 绑定失败时目前是**完全静默**的：UI 正常、MCP 服务不存在、无任何提示。2026-07-25 的 release 实例就处于此状态整整半天，导致 5 条在途 worker 的 MCP 全部失联而无人知晓。本任务让这个失败**看得见**。

## 你的身份与边界

- 工作树：`/mnt/d/04_workspace_rust/cc-book-wt-orch`，分支 `0113-orch-lifecycle`（已建好，**只在此工作树内改动**）
- **不要 push**，不要合并回 main，不要动其它工作树
- **不要修改** `docs/57-ccpanes-ctl-and-mcp-orphan.md`（那是规格）
- 主工作树 `/mnt/d/04_workspace_rust/cc-book` 和 `cc-book-wt-notify` 都有 agent 在并行工作，**绝不触碰**

### ⚠️ 并行冲突规避（重要）

另一个 worker 正在改这些文件，**请尽量避开；必须碰时把改动压到最小、最局部**：

```
cc-panes-core/src/models/settings.rs
web/components/layout/AppShell.tsx
web/components/settings/GeneralSection.tsx
web/components/settings/SettingsPaneContent.tsx
web/components/StatusBar.tsx           （它可能会碰）
```

因此 UI 部分的偏好是：**新建独立组件文件**（如 `web/components/OrchestratorAlertBanner.tsx`），在 `AppShell.tsx` 里只加**一行挂载**；报警文案的落点优先选 `web/components/settings/WebAccessSection.tsx`（那里已经在展示 orchestrator 状态，见下）。**不要**为本任务新增设置开关（会撞 GeneralSection/settings.rs）。

## 规格

`docs/57-ccpanes-ccpanes-ctl-and-mcp-orphan.md` 的 **§1 工作项一**（文件名实际为 `docs/57-ccpanes-ctl-and-mcp-orphan.md`）。核心四条：

1. `OrchestratorStatus` **新增** `lifecycle`（binding / ready / failed）、`attempt`、`lastError`、`nextRetryAt`；
2. 定义前端获取方式（事件 emit 或轮询）、重试取消规则、单实例约束；
3. **UI 可见报警**：附逃生阀 `CC_PANES_ORCHESTRATOR_PORT` 的指引，**禁止静默降级**（CLAUDE.md「降级必须对用户可见」）；
4. 纵深防御：有界退避重试。

## 现状事实锚点（已核实，直接用）

| 事实 | 位置 |
|---|---|
| `OrchestratorStatus` 当前**只有** `port` + `bind` | `src-tauri/src/commands/orchestrator_commands.rs:16-21` |
| 命令实现 | 同文件 `:23-31`（`get_orchestrator_status`），注册于 `src-tauri/src/lib.rs:141,2439` |
| 前端调用 | `web/services/mcpService.ts:61` → `invoke<OrchestratorStatus>("get_orchestrator_status")` |
| 现有唯一展示处 | `web/components/settings/WebAccessSection.tsx:347-350`（显示"当前实际监听 host:port（reason）"） |
| 绑定逻辑 | `src-tauri/src/services/orchestrator_service.rs` 的 `bind_fixed_port()` / `bind_non_inheritable_listener()`；失败点是 `bind_fixed_port` 的 `Err` 分支 |
| 固定端口 | `cc-panes-core/src/utils/orchestrator_manifest.rs`：`ORCHESTRATOR_FIXED_PORT`（dev 47822 / release 47821），逃生阀常量 `ORCHESTRATOR_PORT_ENV` |

### 重要背景：幽灵 socket 根因**已经修好了**，不要重复解决

`059f386` 已修根因——Windows 监听 socket 句柄被 PTY/Web 子进程继承，父进程退出后子进程仍攥着句柄，导致端口显示 LISTENING 但无人 accept。现已改用 `socket2` 经 `WSASocketW` 以 `NO_HANDLE_INHERIT` 创建。

**所以退避重试不是主角**，它只用于兜住"端口被第三方程序真占用"的瞬时态。**主角是把失败暴露给用户。** 不要写成"疯狂重试直到成功"——重试要有界，穷尽后必须报警而不是继续静默转圈。

## 实施要点

- [ ] Rust：`bind_fixed_port` 失败后有界退避重试（次数与间隔写成常量并加注释说明依据），期间 lifecycle=`binding`、`attempt` 递增、`nextRetryAt` 可读；
- [ ] Rust：穷尽后 lifecycle=`failed` + `lastError` 保留可读原因（含"本构建为 dev/release、固定端口 X、逃生阀环境变量名"，现有错误文案已有这些素材，复用别重写）；
- [ ] Rust：成功后 lifecycle=`ready`，并清空 `lastError`/`attempt`；
- [ ] Rust：**重试取消**——应用退出时不得留下悬挂的重试任务；单实例约束（不允许并发两个绑定循环）；
- [ ] Rust→TS 类型同步：`OrchestratorStatus` 的 TS 类型（在 `web/types/` 下，`serde(rename_all="camelCase")` 已在结构上，注意字段名对齐）；
- [ ] 前端：独立报警组件（新文件），lifecycle=`failed` 时可见；文案说明"MCP 服务未启动，已注入的 CLI 会话无法使用 MCP 工具"+ 逃生阀指引 + 重试中显示 attempt/nextRetryAt；
- [ ] 前端：`WebAccessSection.tsx` 的现有展示处补 lifecycle 与 lastError（这是回访入口）；
- [ ] 获取方式二选一（事件 emit 或轮询）——**选了哪个要在报告里说明理由**；若用轮询，频率必须克制（CLAUDE.md 有"不要给全部注册项目起常驻轮询"的前科）。

## 验证

```bash
cargo clippy --workspace -- -D warnings ; echo "EXIT=${PIPESTATUS[0]}"
cargo fmt --all -- --check
cargo test -p cc-panes --lib orchestrator      # 或你新增测试所在的定向过滤
npx tsc --noEmit
npx vitest run <你改动涉及的测试文件>
```

⚠️ **不要用 `| tail` 判断成败**——tail 会掩码退出码，必须 `PIPESTATUS`（这个坑今天已骗过一次人）。

⚠️ 不要跑 `cargo test --workspace`（会被 daemon 文件锁阻塞）。

⚠️ 你在 WSL，Windows 目标的完整 check 可能因缺 MSVC 工具链失败——**这不算你的失败**，如实写进报告即可，不要为此改代码。

⚠️ 人工验证方法（若你能做）：占住固定端口（起一个监听 47822 的进程）→ 启动 dev → 观察 lifecycle 变化与报警 → 释放端口 → 观察自动恢复。做不到就在报告里给出**可执行的验证步骤**留给 leader 在 Windows 宿主做。

## 提交与交付

- 建议两次 commit：Rust 侧（lifecycle + 重试）、前端侧（报警展示）；前缀 `feat(orchestrator):`；
- 完成后在工作树根写 `WORKER-REPORT.md`（**不要 commit**），包含：
  1. 状态 IMPLEMENTED / PARTIAL / BLOCKED；
  2. 关键文件:行号；
  3. **明确列出没做到或没验证的部分**——诚实比完整重要；
  4. 验证结果：跑了哪些命令、退出码、通过数；
  5. 获取方式（事件 vs 轮询）选择理由；
  6. 你碰了哪些"并行冲突规避"清单里的文件、改动多大（leader 合并时要据此判断）。
- 最后一行打印 `ORCH-TASK-COMPLETE`（**不要**用 WORKER-DONE，避免与其它 worker 的监控信号串台）。

## 工量

约 0.5-0.75d。范围要克制：这是一个可观测性小件，不要顺手重构 orchestrator 启动流程。

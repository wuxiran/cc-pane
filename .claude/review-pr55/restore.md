# PR #55 恢复链路审查（feat(restore): 异常退出旧 daemon 的冷恢复）

审查范围：恢复链路相关改动（reconcile 改写 / coldRestore / daemon server / terminal_backend / 与 main 最新恢复修复的冲突面）。
基线：PR base `0bb1305`（merge-base `0591742`，2026-08-05 10:27）；当前 main `0bb1305`（含 v0.11.12、恢复日志中文化 `4cd6ac2`、凭证修复 `34053d7`）。

## 逐条结论

### 1. reconcile 改写 vs fail-closed 语义 —— 无问题（设计正确），一个小疑点

`web/hooks/useTerminalSessionRestore.ts`（diff @163-278）：

- **没有绕过 identity-mismatch / missing-provenance 拦截**。冷恢复入口只对 `restoreBlockedReason === "claims-unsupported"` 开放（`TerminalTabContent.tsx` 的 `BlockedRestorePanel`：`canColdRestore = reason === "claims-unsupported" && Boolean(leaf.savedSessionId)`；`terminalColdRestoreActions.ts::beginTerminalColdRestore` 二次守卫 `leaf.restoreBlockedReason !== "claims-unsupported" || !leaf.savedSessionId` 即拒绝）。identity-mismatch / missing-provenance / claim-conflict / ambiguous-candidates 的 leaf 仍然只显示阻断面板，无按钮。`identityMatches` 本身未被改动（claims-supported 主路径逻辑不变，只是把 `liveIds` 计算上移）。
- **不会自动造出重复 `--resume` 双进程**。分支表：
  - 旧 daemon（claims 不支持）+ 旧 PTY **仍活**：保持阻断（`daemon-snapshot.blocked reason=claims-unsupported`），只提供人工按钮；按钮流程是 **先 kill 成功才建新 PTY**，kill 失败回滚并不启动（`coldTerminalRestore.ts` catch 分支 `finishTerminalColdRestore(..., false)` 后 rethrow）。这正是 0.11.3 fail-closed 想防的场景，语义保住了。
  - 旧 PTY **不在** daemon 会话列表（已死）：静默清阻断转冷恢复。这与 main 上 claims 主路径既有行为一致（`candidates.length===0 && savedSessionId 不 live` 时也是 `setTerminalRestoreBlocked(..., undefined)`），不是新放宽。
  - in-process 后端：直接 `restoreLiveDaemonSessions` 原位 reattach——in-process PTY 本就是本 app 独占，无跨实例仲裁问题，合理。
- **claims 支持但快照不完整**：原因从 `claims-unsupported` 改为新枚举 `reconciliation-failed`——依旧 fail-closed，且文案更准（`claims-unsupported` 现在意味着"可冷恢复"，语义拆开是必要的）。`web/types/terminal.ts:78-79` 两个值都已在类型里。
- 小疑点（低危）：`backendMode` 探测失败时假定 `"daemon"`（diff @166-169）。若实际是 in-process 后端且 `getDaemonClientInfo` 抛错，活的 in-process 会话会被标 `claims-unsupported` 并显示冷恢复按钮——点了会 kill 自己独占的活会话再重建。降级方向仍是 fail-closed（不自动做事），可接受，但按钮文案"后端版本较旧"在这种场景是误导。

### 2. coldRestoreBlockedTerminal 实现 —— 无问题

- **kill 路径**：`terminalService.killSession` → daemon backend `kill_with_reason` → daemon DELETE `/api/sessions/:id` → 既有 kill 链（Windows `taskkill /T /F` 树杀，`cc-panes-core/src/pty/mod.rs::kill_process_by_pid`，本 PR 未动）。旧 daemon 对带 `?reason=` 的 DELETE 天然兼容（daemon_client.rs:449 注释）。
- **launch id 语义正确**（CLAUDE.md/docs/69 gotcha）：`finishTerminalColdRestore` 成功分支 `leaf.launchAttempt += 1`（`terminalColdRestoreActions.ts`）→ `TerminalTabContent` 用 `` key=`${leaf.id}:${launchAttempt}` `` 强制重挂 → `TerminalView` 的 `resolveLaunchId({ launchAttempt })`（`terminalLaunchIdentity.ts:40`：`launchAttempt > 0` 一律 `nextLaunchId`）→ 全新一次性 launch id，不复用被占用的旧 id。resumeId 保留在 leaf 上随新 create 传入。
- **kill 事件竞态已处理**：begin 时先摘掉 `savedSessionId` 但**保持阻断**（注释明说"detach the old id before its session-killed event can close this terminal leaf"），阻断期间渲染的是 BlockedRestorePanel、无 TerminalView 挂载，不会有并发 launch；kill 的 session-killed 广播找不到引用该 id 的 leaf，不会误关标签。失败回滚恢复 `savedSessionId` + 阻断。
- 残余小竞态（记录即可）：daemon 的 kill 返回 2xx 与子进程树真正死透之间有毫秒级窗口，理论上新 `--resume` 可能与垂死旧进程短暂并存。树杀是同步发起的，实际风险很低，且这是既有 kill 链的性质，非本 PR 引入。

### 3. daemon server.rs / terminal_backend.rs —— 无问题（claims 协议不变式未动）

- `cc-panes-daemon/src/server.rs`：改动仅为 create 响应加 `resolvedModelId` 字段（`#[serde(default)]`，旧客户端反序列化不受影响）+ 超时晚到 kill 用 `outcome.session_id`。**adoption-snapshot、claim/adopt/release 端点、create+claim 原子化（docs/61 评审 #2）全部未动**。
- `terminal_backend.rs`：新增 `terminal_link_context`（路径链接功能，默认 `Ok(None)` fail-closed）与 `create_session_with_outcome` 转发。`claims_supported()` 默认 false（评审 #11）未动；in-process 默认快照 `claims_supported:false, complete:true` 未动。
- `daemon_client.rs` 的 `ResponseField`：区分「旧 daemon 缺字段」（回退请求方的 model_id）与「新 daemon 显式 null」——符合 CLAUDE.md「服务端新增字段必须可缺失」的分级判定，有配套测试。
- 版本错配矩阵核对：旧 daemon 404 fallback（daemon_client.rs:375-397）产 `claimsSupported:false, complete:false, sessions=list_sessions()`——新前端在 `!claimsSupported` 分支把这份 `sessions` 当活会话真值。`list_sessions` 失败时整个 snapshot 报错走 `reconciliation-failed`，不会拿残缺列表误判"已死"。成立。

### 4. 基线陈旧度与 main 冲突 —— **有实质冲突，必须先 rebase**

PR base = `0591742`（8-05 上午），落后当前 main **17 个提交**，其中三个与本 PR 正面相撞。`git merge-tree` 实测 **8 个文件内容冲突**：

| 冲突文件 | 撞的 main 提交 | 性质 |
|---|---|---|
| `web/components/panes/TerminalTabContent.tsx` + `.test.tsx` | `4cd6ac2` 恢复日志中文化 | **文本+语义**：两边都改写了 RestoreLogSurface 区域；且 PR 新增 6 个恢复日志事件（`cold-restore.kill.begin/failed/end`、`cold-restore.create.ready`、`in-process-session.reattach-ready`、`daemon-snapshot.cold-restore-ready`）与新 reason `reconciliation-failed` 变体，main 的 `terminalRestoreLogFormat.ts` 事件文案表（64 个键）**都没有**——会落到 `restoreLog.unknown` 兜底（原样英文事件名），不崩但中文化对这批新事件失效。合并时需补 `restoreLog.events.*` 键。 |
| `src-tauri/src/commands/terminal_commands.rs` | `34053d7` 凭证修复 | 文本冲突：main 把凭证落库抽到 `session_provenance_persist.rs` 共用实现，PR 在同一区域重构 launch_binding + 新增 `bind_or_add_created_session` 兜底。语义不互斥（凭证链与落库链分属两段，见 docs/69 判据），但 rebase 时要保住 main 的 `persist_created_session_or_cleanup` fail-closed 组合入口。 |
| `src-tauri/src/services/orchestrator_service.rs` | `34053d7` | **语义冲突重点**：main 把凭证落库点放进 `create_backend_session_with_deadline` 成功出口；PR 恰好改了这个函数的返回签名（三元组→四元组带 `resolved_model_id`）。rebase 必须在同一函数里合两笔，属易错点，建议合并后跑 main 新增的凭证回填测试。 |
| `cc-panes-web/src/routes/terminal.rs` | 同上游重构 | 文本冲突。 |
| `LaunchProfilesPanel.tsx` / `ProviderFormPanel.test.tsx` / `ProviderModelsEditor.tsx` | `ea8d55d` Provider 两页重构 | 非恢复链路，但同 PR 打包，冲突量不小。 |
| `web/test/lineRatchet.baseline.json` | 多笔 | 机械冲突，重新生成即可。 |

与凭证修复的**语义**关系：PR 的 reconcile 改写在 `!claimsSupported` 时提前 return（不进 `identityMatches`），claims 主路径原样保留——main 的 `identityMatches` / provenance fail-closed 不受影响，两者正交。冷恢复走的是「杀旧建新」而非「认领」，不消费 provenance，无绕过。

### 5. 其他恢复相关观察

- `history_repo.rs::bind_pty_session` 加了 `model_id` 回写，WHERE 子句未动（`project_id = launch_id` 的一次性语义保持）。新增 `bind_or_add_created_session`：bind 落空时**插入**兜底行——这实际缓解了 docs/69「恢复出的会话不写行、永久退化」的不可自愈问题，方向正确。小疑点：若旧行存在但 `pty_session_id` 被别的 PTY 占用（docs/69 场景），会出现同一 launch_id 两行；`find_by_launch_id` 的取行顺序需确认不歧义（低危，建议作者补一条测试）。
- `docs/81-abnormal-exit-session-recovery.md` 的决策表与实现一致（逐条核对过五个分支）。
- `useAppLifecycleLate.ts` 放开 themeMode 白名单——与恢复无关，混入本 PR，属打包面过宽。

## 合并建议：**拆开合 + 需作者先 rebase**

这个 PR 是 5 个 feature 的合包（provider 复制 / 状态栏 / 上下文用量 / 冷恢复 / --settings 注入 / 还夹带 terminal-path-link 整个功能），146 个文件。恢复链路部分本身设计是对的（fail-closed 未破、kill-before-create、launch id 语义正确、daemon claims 协议未动），**单看冷恢复可合**；但：

1. **必须先 rebase 到当前 main**：8 文件实冲突，其中 `orchestrator_service.rs`（凭证落库点 vs 返回签名改动同函数）和 `TerminalTabContent.tsx`（日志中文化 vs BlockedRestorePanel 同区域）是语义级，机器合不出来。
2. **rebase 后需作者补**：新增 6 个恢复日志事件 + `reconciliation-failed` reason 的 `restoreLog.events.*` 中英文案（否则新事件显示英文原始键，与刚合入的中文化目标相悖）。
3. 建议（非阻塞）：`backendMode` 探测失败时冷恢复按钮的文案区分「探测失败」与「后端过旧」；`bind_or_add_created_session` 双行歧义补测试。
4. 若作者可拆：冷恢复（`coldTerminalRestore.ts` / `terminalColdRestoreActions.ts` / reconcile 改写 / BlockedRestorePanel / docs/81）+ resolved_model_id 链是一个自洽单元，provider/状态栏/path-link 各自独立，拆开能显著降低 rebase 与回归风险。

# 86 — Resume 恢复链路陈旧化：三症状归因与结构性修复

> 状态：三批已实施（0.12.1），待 Windows 宿主端到端验收。
> 起因：用户报告「关掉重启会恢复旧的日志」——对话内容旧 / 终端画面旧 / 恢复成空会话三类症状混合。
> 经两轮代码调查 + WSL Codex 同行评审（必修 4 条、开放 3 条，全部拍板）后按结构性方案实施。
> 排障判据速查在文末。

## 1. 症状归因

| 症状 | 根因链 |
|---|---|
| **对话内容旧** | 恢复用快照里的 `leaf.resumeId`（刻意不查 history，`terminalResume.ts` 回归防线）→ 该值只在后端事件命中活会话时刷新 → 任一环断掉即**永久冻结**，每次重启 `--resume` 同一历史点，无报错 |
| **终端画面旧** | 冷恢复重放 `sessions/<savedSessionId>.output` **无任何时效/世代校验**（活会话 attach 的 checkpoint epoch 校验是闭环的，冷恢复这条路压根没有 epoch 概念）；创建失败不清理 → 同一份旧画面可无限循环重放；`sessions/` 零 GC |
| **恢复成空会话** | resumeId 失效时 CLI 报错退出，仅后端 120s 窗取证 WARN（`terminal_service.rs` `wait_resume_diag`），前端零提示（docs/45 §5 遗留） |

## 2. 让 resumeId 冻结的六条断链（调查编号）

- **D 绑定竞态**：`issued` 事件 PTY spawn 后立即 emit，`bind_pty_session` 等 create_session 返回后才跑；`bind_resume_id` 旧窗仅 10×500ms=5s。WSL 慢启动 >5s → `upsert_missing_row`；叠加旧 launchId → 撞 V29 唯一索引 → 永久丢号无重试。
- **A 旧 launchId 复用**：`cleanRehydratedPanes` 只对快照里 `sessionId` 非空的 leaf 置 `restoring=true`；leaf 已退出但带 savedSessionId 时 `resolveLaunchId` 走复用分支（判据比 `useTerminalSessionRestore` 的恢复筛选窄）。单独出现造成绑定落空，与 D 叠加致命。
- **O1 快照不知情**：`updateTabAgentResumeId` / `setTabResumeBinding` 都不发 `notifyTerminalLayoutChanged`——快照 resumeId 只靠 60s 定时器与正常关闭刷新；异常退出最多陈旧 60s。
- **H 回写耗尽即丢**：前端回写 leaf.resumeId 仅重试 6 次（~10.5s），耗尽后 DB 有值、快照无值，永久分叉。
- **C codex resume 单通道**：resume 启动的 codex 关闭 rollout 兜底（`rollout_fallback: resume_id.is_none()`），OSC 捕获耗尽只 warn 一次即静默零事件。
- **G 重放噪音**：daemon `identity_events` 会话死后不清除，app 每次重启全量重放（DB 写 + history-updated 风暴）。

历史修复核实均在位：docs/45 daemon 边界（契约表 + 守卫测试 + 留存/补拉）、docs/69「只能恢复一次」（`bind_or_add_created_session` + `upsert_missing_row`）、**V29 去重迁移 + `idx_launch_history_project_id_unique`**（评审纠正：调查初稿按"无唯一索引"写，已过时）。

## 3. 评审决议（Codex WSL，2026-08-07）

1. O5「无唯一索引」分析过时 → 改为验证既有约束，LIMIT 修复不做。
2. 缺口 A 不止补判据 → 恢复态收敛到 `phaseOf` 单源。
3. 缺口 D 二次窗只对「新 launchId 慢启动」成立，**依赖 A 先修**；旧 launchId 下 upsert 撞唯一索引不能等待自愈，是结构错误信号。
4. O3 快照 merge 方案否决 → 拆独立 ResumeBindingStore（布局快照只管树，身份另存）。
5. 投递采纳 outbox+ack；rollout 兜底不放开（已有 `launch_started_at` 下界，缺的是来源裁决）；回写耗尽补晚到回填。

## 4. 实施记录（三批）

### 批1 止血（前端）
- `terminalLaunchIdentity.ts`：`resolveLaunchId` 换新判据改为 `phaseOf({restoring, savedSessionId, launchAttempt})` 派生（`isPendingPhase`），`TerminalView` init 路径补传 `savedSessionId`。
- `usePanesStore.ts`：`updateTabAgentResumeId` / `setTabResumeBinding` 变更后发 `notifyTerminalLayoutChanged("resume-id.update")`，**同值 no-op**（对冲 identity 重放）。
- `useTerminalSessionRestore.ts`：回写重试 6→12（退避封顶 5s），耗尽进 `pendingResumeBindings`（10min TTL），`session.update` 布局事件触发重放。
- `TerminalView.tsx`：init/deferred 两条路径**终态失败**时 `clearOutput(savedSessionId)`（cancelled 不清）——杜绝旧画面无限循环重放。

### 批2 结构性主体
- **`useResumeBindingStore.ts`（新）**：resume 身份的前端权威镜像，key=ptySessionId，`{resumeId, source, version}`；来源仲裁镜像 `resume_identity.rs`（manual40 > issued/osc-title30 > rollout/backfill10 > rescue5，同级 `>=` 覆盖）；persist + 14 天 TTL。写入方 = history-updated 事件桥；读取方 = `pickCreateSessionResumeId`（按 savedSessionId 精确命中优先于快照副本；**不违反禁 history 目录兜底的回归契约**——按 PTY id 精确路由无劫持可能）。布局快照不 merge、不仲裁。
- `resume_binding_service.rs`：主窗 5s→12s（24×500ms）；`upsert_missing_row` 分型 `Created/RowOccupied/Skipped`；RowOccupied（撞 V29 索引 = 旧 launchId 结构信号）不终局，进二次窗（6×1s 按 PTY 精确重绑，等 create 侧建行）。
- `session_restore_service.rs`：新增 `prune_stale_outputs(14天, 保护集)`；命令 `prune_stale_session_outputs`；启动对账完成 30s 后由前端触发，保护集 = `collectSnapshotSessionIds`（含 savedSessionId）∪ 共享引用集，任一来源不可达即放弃。

### 批3 投递可靠性 + 可见化
- **outbox+ack**：入站契约新增 `identityAck`（两侧契约表 + `server.rs ControlInboundMessage::IdentityAck` + `ws_emitter.ack_identity_events`）。app 侧 control link 在 replay/live 绑定完成后经 ack 队列逐批发送；**只删 resumeId 一致的条目**（换 id 的新事件存活）；ack 丢失由重连补拉的「已应用」路径补发（自愈）；旧 daemon 静默忽略不劣化。缺口 G 由此消解。
- **resume 失败可见化**：复用 `terminal-launch-warning` 必达通道新增 kind `resumeLaunchFailed`（`wait_resume_diag` 命中错误特征才发，手动退出不误报）+ `codexResumeCaptureExhausted`（resume 会话 OSC 耗尽，单通道场景）。前端 `useLaunchWarnings` toast。**面板级动作（phaseOf → LaunchErrorPanel）依赖 exit→leaf 写回接线（docs/78 遗留），本批仅 toast**。
- rollout 兜底**不放开**（决议 5）。

## 5. 排障判据速查

- 日志无 `bind_resume_id` 行 = 捕获/桥接断（docs/45 方向）。
- 有但 `no launch_history row matched` = 落库断；再见 `launch id row occupied by another PTY ... entering rebind window` = 命中旧 launchId 复用（缺口 A 未修净的信号，二次窗会兜）。
- toast「会话恢复失败」= resume id 失效（A4）；toast「Codex 会话 id 捕获失败」= 本次运行零事件（缺口 C），下次恢复会回到旧对话。
- 重启后对话旧：先查 `cc-panes-resume-bindings` localStorage 的该 PTY 绑定 vs DB `launch_history.resume_session_id`——store 断了查事件链，store 对但恢复错查 `pickCreateSessionResumeId` 消费方。

## 6. 验收（Windows 宿主，未完成项）

1. 两次重启 `withResumeId` 不掉零（docs/69 验证节；含 WSL codex）。
2. `/clear` 换 id 后 30s 内 `taskkill /F`，重启恢复到新会话。
3. 制造创建失败 → 两次重启，第二次无 `--- Session restored ---` 旧画面；14 天孤儿 .output 被 GC。
4. 手改 resumeId 为随机 UUID → 重启出现失败 toast 而非一闪即空。
5. 杀 app 重启，daemon 留存已 ack 事件不重复落库（日志无重复 bind 行）。
6. **daemon 二进制必须重建拷贝 `debug\binaries\`**（binaries 陈旧 gotcha），否则 3.x 全部"测试绿但不生效"。

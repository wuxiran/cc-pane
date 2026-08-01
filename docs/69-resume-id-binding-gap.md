# 69 — resume id 落库缺口：恢复出来的会话只能恢复一次

> 0.11.7 实测：一次重启 18/18 个 tab 全无 resumeId，6 条已送达的 resume id 事件全被丢弃。
> 与 [45](45-codex-resume-capture-dead.md) 不同——那次是 **捕获**链断（拿不到 id），
> 这次是 **落库**链断（拿到了但没地方存）。两者会互相伪装，排查时先分清在哪一段。

## 现象与实证

用户 2026-07-31 12:44 更新到 0.11.7 并重启，18 个终端标签一个都没恢复。

`%LOCALAPPDATA%\com.ccpanes.app\logs\cc-panes.log`（时间戳 UTC，本地 +8）的启动自检：

```
[restore-report] {"total":18,"withResumeId":0,"withoutResumeId":18,
  "byCliTool":{"claude":{"bound":0,"unbound":5},"codex":{"bound":0,"unbound":13}}}
```

`launch_history.resume_session_id` 的绑定率按天塌成零：

| 日期 | 绑定/总数 |
|---|---|
| 7-25 | 21/35 |
| 7-26 | 6/39 |
| 7-27 | 0/10 |
| 7-28 | 1/6 |
| 7-29 | **0/27** |
| 7-30 | **0/25** |
| 7-31 | **0/1** |

同期 `pty_session_id` 非空率 100% —— PTY 绑定正常，只有 resume 这一段断。

## 两条独立故障

### F1 — daemon 边界丢身份事件（0.11.6 及更早，0.11.7 已修）

PTY 迁到 daemon 后 `terminal-resume-id-detected` 到不了 app 进程，解释 7-27~7-30 的 0/27、0/25。
0.11.7 的 `5db34a9`（daemon 侧留存身份事件 + `GET /api/sessions/identity` + 重连补拉）已解决。

**实证已修**：更新后日志里 6 条事件全部送达，`source=issued`、带完整 `launch_id`：

```
resume_session_id=bdb235ac-… source=issued launch_id=Some("proj-0d2802c5-…")
… 共 6 条
```

排查同类问题时，这一段的判据是：日志里**有没有** `bind_resume_id` 行。
没有 = 事件没到（F1 类）；有但报 `no launch_history row matched` = 落库失败（F2 类）。

### F2 — 恢复路径不建行，resume id 无处落库（本次修复）

那 6 条**全部**被丢弃。链路：

1. **恢复路径不 INSERT 行**。`TerminalView.tsx` 的 `init.create` / `activation.create` 直接
   `terminalService.createSession({ launchId: props.projectId })`。真正 INSERT 行的是新 launch
   走的 `useOpenTerminal.ts` 里的 `historyService.add()`，恢复不经过它。

2. **`launch_history.project_id` 不是项目 id，是每次启动唯一的 launch id**（`proj-` 前端生成 /
   `orch-` orchestrator 生成）。实测 cc-book 有 307 行、307 个不同 `project_id`。
   而 tab 手里的 `props.projectId` 是它**上一次** launch 的 launch_id。

3. 于是 `bind_pty_session`（`history_repo.rs`）必然落空——候选条件要求
   `pty_session_id IS NULL OR = 本次`，而那行的 pty 已被**上一次**的 PTY 占用：

   ```sql
   UPDATE launch_history SET pty_session_id = ?1
   WHERE id = (SELECT id FROM launch_history
               WHERE project_id = ?2 AND cli_tool = ?3
                 AND (pty_session_id IS NULL OR pty_session_id = ?1)
               ORDER BY launched_at DESC LIMIT 1)
   ```

4. `bind_resume_id` 随后按 `find_by_pty_session_id` 找行，10×500ms 重试全落空，
   旧策略是「只 UPDATE 不 INSERT」→ **仅告警，resume id 永久丢弃**。

5. 兜底 `startLaunchHistoryBackfill` 被 `if (!effectiveResumeId)` 挡在门外。

**净效果是不可自愈的退化**：恢复出来的会话不写 `resume_session_id` → 下次重启它没有
resumeId → 只能开空会话 → 这个空会话同样是恢复路径产物 → 永远回不来。
DB 佐证：更新后（`launched_at > '2026-07-31T04:44'`）的 `launch_history` 行数 = **0**，
而那段时间明明创建了多个会话。

## 修复

两条都只在「行不存在」这一种失败上兜底，不改动正常路径的优先级判据。

- **`src-tauri/src/services/resume_binding_service.rs`**：重试耗尽后调
  `upsert_session_started` 建行（复用既有函数，`launch_backfill_service` 早有同样用法），
  再补一次 `update_resume_session_with_source_by_pty` 写 `resume_source`。
  `launch_id` / `project_path` 缺一不可，缺了宁可不建——拿占位值硬凑会在启动历史里
  留下指向错误目录的记录。放在 CLI 冲突拒绝之后：冲突的事件不该建行。

- **`web/components/panes/TerminalView.tsx`**：两处 `startLaunchHistoryBackfill` 去掉
  `!effectiveResumeId` 门槛（`cliTool !== "none"` 保留，纯 shell 没有 resume 语义）。
  backfill 内部对「行已有 resume_session_id」会提前退出，不会覆盖已绑定的值。

  **但别高估这条**：`run_launch_history_backfill` 开头就有
  `backfill_enabled()` 闸门，读 `terminal.resume_id_backfill_enabled`，默认 `None →
  false`，代码里没有任何地方置 true（只有 Settings→终端 的手动开关）。
  也就是说**默认配置下这条改动不产生任何行为**——backfill 是 legacy 路径，早已被
  issued/osc-title 绑定取代。真正修好问题的是上面那条 `resume_binding_service` 兜底。
  保留它只是让「用户手动开了 legacy backfill」这条路径也自洽。

### 一个依赖约定而非约束的地方

`upsert_session_started` 的 `WHERE project_id = ?` **没有 LIMIT**，命中几行取决于
`project_id` 是否唯一。而 `launch_history` 的 schema 里
`project_id TEXT NOT NULL` —— **没有 UNIQUE 约束，也没有唯一索引**。

唯一性目前完全由生成端保证：`useOpenTerminal.ts` 的 `proj-${crypto.randomUUID()}` 与
orchestrator 的 `orch-{uuid}`，三个 INSERT 点都不复用 id（实测 2294 行 / 2294 个不同值）。
所以当下只命中 1 行，覆盖旧行也正好维持 `find_by_launch_id`、`bind_pty_session` 的
`ORDER BY … LIMIT 1` 所依赖的那个假设。

但这是**约定不是约束**：哪天有人让某条路径复用 launch_id 插第二行，这个无 LIMIT 的
UPDATE 就会批量覆写整组记录，而且不会报错。要么给 `project_id` 加唯一索引，要么把
UPDATE 改成 `bind_pty_session` 那种「子查询选一行」的写法。

## 验证

单测：`resume_binding_service` 新增 3 条（行不存在时建行并写 source / `launch_id` 缺失不建 /
`project_path` 缺失不建）；`TerminalView.test.tsx` 新增「带 resumeId 也要 backfill」的回归防线。

端到端（**必须在 Windows 宿主跑**，WSL 全绿不算数）：

1. 起 2 个会话（claude local + codex wsl），确认 DB 里各有一行且 `resume_session_id` 非空
2. 重启 app，日志 `[restore-report]` 的 `withResumeId` > 0
3. **再重启一次** —— 关键回归点：恢复出来的会话自己也写了行，`withResumeId` 不掉回 0
4. 全程不应再出现 `no launch_history row matched` / `launch history row was not available`

```bash
cd ~/.cc-panes && python -X utf8 -c "
import sqlite3
c=sqlite3.connect('file:data.db?mode=ro',uri=True)
for r in c.execute('select launched_at,cli_tool,pty_session_id,resume_session_id,resume_source from launch_history order by launched_at desc limit 5'):
    print(r)"
```

## 附：更新会杀掉 daemon（未修）

同一份日志显示 `12:43:54` 旧 daemon（`127.0.0.1:59002`）连接全断，`12:44:18` 新 app 启动时
`manifest health probe failed`。NSIS 更新要覆盖
`%LOCALAPPDATA%\cc-panes\binaries\cc-panes-daemon.exe`，必然先杀 daemon，PTY 真身随之全灭
——「attach 回存活会话」这条路在**更新**场景下必断，只剩 resumeId 降级路径。

这解释了为什么「更新重启」比「普通重启」丢得更彻底，但它**不是** resumeId 归零的原因。
修好本文的 F2 后，更新场景至少能 resume 回对话历史。根治需改
`src-tauri/nsis/installer-hooks.nsh`（更新前后不动 daemon，或更新后重连存活 daemon）。

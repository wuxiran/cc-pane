# 交叉评审请求 · CC-Panes 0.11.8 阶段 A

你是**独立评审人**。只读评审，**不要改任何代码**。产出一份问题清单。

## 你要评审的东西

- 变更集：`.claude/review-0118/phaseA.diff`（含新增文件全文，1009 行）
- 背景文档：`docs/69-resume-id-binding-gap.md`（同在 diff 里，讲清了根因）
- 项目规范：`CLAUDE.md`（尤其 Known Gotchas 段）

仓库根：`/mnt/d/04_workspace_rust/cc-book`（你在 WSL 里，用这个路径）

## 背景（一句话）

0.11.7 实测：重启后 18/18 个终端标签全部丢失对话历史。查明是两条独立故障，
本变更集修的是其中的**落库链**，外加两条配套加固。

## 变更集的三块

### A1 — resume id 落库兜底
`src-tauri/src/services/resume_binding_service.rs`

根因：`launch_history.project_id` 其实是「每次启动唯一的 launch id」（不是项目 id）。
tab 手里的 `props.projectId` 是它**上一次** launch 的 id，那行的 `pty_session_id`
已被上次的 PTY 占用，于是 `bind_pty_session` 的
`(pty_session_id IS NULL OR = 本次)` 永不命中 → resume id 被丢弃 → 下次重启没
resumeId → 只能开空会话 → 空会话同样是恢复路径产物 → **不可自愈的退化**。

改法：重试耗尽后调既有的 `upsert_session_started` 建行，再补写 `resume_source`。
另外 `TerminalView.tsx` 两处 `startLaunchHistoryBackfill` 去掉了 `!effectiveResumeId` 门槛。

### A2 — 更新不再杀 daemon
`src-tauri/nsis/installer-hooks.nsh` + `src-tauri/src/services/terminal_daemon_lifecycle.rs`

根因：安装钩子主动 `taskkill /F /T` 掉 daemon，`/T` 杀整棵进程树，
而 PTY 会话全挂在 daemon 底下。

改法：更新路径放过 daemon 并改名旧 exe（Windows 允许重命名运行中的文件）；
换代时机交给 app —— `decide_daemon_upgrade` 只在 `session_count == 0` 时才优雅换代。
判据用 **exe mtime vs 进程 started_at**（不用版本号：daemon crate 版本长期停在 0.1.0）。

### A3 — 恢复回归可见化
`web/utils/restoreReport.ts`、`web/stores/useRestoreReportStore.ts`、
`web/components/RestoreRegressionBanner.tsx`

`[restore-report]` 本来只写日志文件，那次三天 100% 未绑定无人发现。
现在全员未绑定时在 AppShell 顶部出一条非模态告警。

## 请重点攻击这些点（按重要性）

1. **A1 的 upsert 兜底会不会造出错行或脏数据？** 特别是：
   - `upsert_session_started` 的 UPDATE 分支是 `WHERE project_id = ?`（无 LIMIT）。
     我判断 `project_id` 每行唯一所以只命中 1 行（实测 2294 行 / 2294 个不同值）。
     **这个不变式是否真的成立？** 有没有路径会造出两行同 project_id？若不成立就是数据破坏。
   - 兜底放在 `rejected` 判定之后、来源优先级判定之外。会不会让低优先级来源
     （osc-title）绕过 `should_replace_source` 盖掉高优先级的 issued？
   - 并发：同一 pty 的两个事件同时走到兜底，会不会插两行？

2. **A2 会不会让用户永远停在旧 daemon？** 只在无会话时换代——如果用户长期挂着会话，
   新 daemon 可能几周都不生效，而 app 已是新版。新 app + 旧 daemon 的协议兼容边界在哪？
   另外 mtime 判据在什么情况下会失效（时钟回拨？安装器保留原 mtime？重装同版本？）。

3. **A2 的 NSIS 改动**：改名 `.old` 后若 app 再也不启动，磁盘会不会残留一堆 .old？
   卸载路径是否真的还会清干净？`keepDaemon` 宏参数传递写法在 NSIS 里是否正确？

4. **A3 的判据 `total > 0 && withResumeId === 0`** 会不会误报/漏报？
   例如全是纯 shell 标签的正常启动。

5. 有没有**更该改而没改**的地方 —— 比如根因既然是「复用上次的 launch id」，
   是不是应该在恢复时就生成新的 launch id，而不是靠下游兜底？

## 输出格式

按严重度排序，每条给：`文件:行` + 问题 + **具体的失败场景**（什么输入/状态 → 什么错误结果）。
拿不准的标「存疑」并说明验证方法。没问题的部分不用夸，直接跳过。

如果你认为整个方案方向错了，直接说，并给出你认为对的方案。

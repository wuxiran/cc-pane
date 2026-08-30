# 95 · Automations：定时派 ACP agent（docs/55 H1 最小版落地）

> 状态：已落地（0.12.x）。对标 Orca 的 Automations 页，按 55-H1 的最小版判定裁剪。

## 1. 决策与边界

Orca 的「自动化」主体是一整页定时派工产品（cron/RRULE、precheck、无头派发、错过宽限、
运行历史、外部 cron 聚合，约 90+ 文件）。docs/55 H1 当时判 P2 并给出最小版定义：
**保存 prompt + 项目 + 引擎 + cron + 运行历史，不接外部 automation managers**。本次按该
定义落地，并明确不做：

- 外部 cron 管理器（Hermes/OpenClaw）聚合
- 事件规则引擎（「完成/失败 → 自动做 X」）
- 失败自动重试链
- precheck 命令（需要时再加）

## 2. 与 Orca 的一个关键差异：派发目标是 ACP headless 会话

Orca 到点必须有窗口（或 `orca serve`），否则 `skipped_unavailable`。我们的派发目标是
**ACP 无头会话**（`AcpChatService`，app 进程内 stdio，非 PTY、不开标签）：

- 到点 `start()` 一个 `auto-<defId>-<ts>` 会话（注入 ccpanes MCP），`prompt_and_wait()`
  等回合结束，记录 stopReason 后 `stop()` 回收——不留孤儿 adapter。
- agent 想开终端、派 worker、写 todo，经注入的 ccpanes MCP 自己来，不需要 UI 在场。
- 无人值守权限：`AcpLaunchSpec.auto_approve_permissions`，`session/request_permission`
  自动选第一个 `allow*` 选项（无 allow 时取第一个），emit `ccpanes/auto-approved` 留痕。
  交互式 chat 恒为 false，只有 automation 会话开启（UI 可关）。

## 3. 结构

| 层 | 文件 | 说明 |
|---|---|---|
| 服务 | `src-tauri/src/services/automation_service.rs` | 定义/运行历史存储 + 30s tick 调度 + 派发 |
| ACP 扩展 | `acp_chat_service.rs` | `auto_approve_permissions` + `prompt_and_wait`（`run_turn` 抽出） |
| 命令 | `src-tauri/src/commands/automation_commands.rs` | list/save/delete/run_now/list_runs |
| 前端 | `web/components/settings/AutomationsSection.tsx` | 设置 → 工具 → 自动化（列表+编辑器+历史） |
| cron 助手 | `web/components/settings/automationsCron.ts` | 预设（每小时/每天/工作日/每周）↔ 5 字段 cron |
| 服务/类型 | `web/services/automationService.ts`、`web/types/automation.ts` | invoke 封装 + 镜像类型 |

存储走文件（与 launch profiles / agent-chats meta 同先例，零 DB migration）：

```
<data>/automations/
├── defs/<id>.json      # AutomationDef（含 nextRunAt）
└── runs/<id>.jsonl     # AutomationRun 追加，读侧只取最近 50 条
```

## 4. 调度语义

- 5 字段 cron（`cron` crate，内部前置秒位 `0 `），保存时校验并算 `nextRunAt`。
- 30s tick 扫全部定义（`plan_tick` 纯函数，有单测）：
  - 未到期/未启用 → 等
  - 到期且在 `graceMinutes`（默认 10）内 → 派发，`nextRunAt` 前移
  - 超宽限 → 记 `skipped_missed`，前移
- 同一定义不重叠：上一次在途时记 `skipped_overlap`。
- 每次运行有 `timeoutMinutes`（默认 30）硬超时，超时记 failed 并回收会话。
- run 状态：`completed`（带 stopReason）/ `failed` / `skipped_missed` / `skipped_overlap`。
- cron 失效（理论不可达，保存时已校验）→ 自动禁用该定义并 warn。

## 5. 已知限制 / 后续

- 运行结果只有 stopReason，不落 assistant 转写（要看过程可先手动 Run now 后从
  agent-chats 历史 `session/load` 续看——meta 由 AcpChatService 正常落盘）。
- app 不在时不跑（无 daemon 侧调度）；错过的按宽限策略处理。这与「PTY 真身在
  daemon」不同：ACP 会话本来就活在 app 进程。
- 通知未接：run failed 目前只进运行历史，不推桌面/IM。要接的话走
  NotificationService 一条 `automation_failed`。

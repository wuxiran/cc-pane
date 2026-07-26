# 61 · 无主会话接管与重复恢复根治

> 2026-07-26 事故调查 + 实施计划。第一部分（UI 接管）已实现，第二部分（启动认领）待评审。

## 事故现象

单机 `claude.exe` 堆到 50 个，占约 19GB，其中只有 21 个不同的 Claude session uuid——**22 个是重复的**，同一个会话被 2~4 个进程同时 `--resume`。UI 资源管理器里显示成一片没有标题的「CLI 终端 \<pid\>」，归在「其他工作区」下，点击无任何反应。

另有 11 个来自 7/24–7/25 的 `claude.exe`，父进程已死且不在 daemon 会话表里，纯泄漏。

## 时间线（进程创建时刻实测）

```
1:17:38  cc-panes-daemon.exe 起（父进程 58244）
1:17:44 ~ 1:17:53   第一批 18 个 claude --resume
1:19:57  cc-panes-web.exe 起（父进程 106744 —— 另一个 app 实例）
1:20:00 ~ 1:20:10   第二批 19 个，uuid 与第一批完全相同
1:33:59  cc-panes.exe（当前存活的实例，PID 97284）
```

今天出现过三个不同的 app PID（58244 / 106744 / 97284），`crash.log` 最后写入是 7/23——**不是崩溃，是正常开关**。第二批比第二个实例的启动晚整 3 秒，对应 `useSessionLayoutPersistence.ts:193` 的 `setTimeout(() => runBackgroundLayoutRestore(), 3_000)`。

> 排查中曾把第二批归因到 `cc-panes-web`，错误。`cc-panes-web/src/main.rs:270` 只把 `SessionRestoreService` 挂进 REST state，**启动时不做任何恢复**；它的启动时刻只是第二个 app 实例的旁证。

## 根因

**恢复的幂等性建在宿主进程内的 store 状态上，而不是跨实例共享的权威事实。**

1. 重连唯一入口 `usePanesStore.restoreLiveDaemonSessions()`（`usePanesStore.ts:2849`）拿 `leaf.savedSessionId` 去匹配 daemon 活会话，而 `savedSessionId` 来自**本 webview 自己**持久化的布局；
2. 新实例拿不到上一个实例刚生成的 sessionId，匹配全落空，返回 0；
3. 3 秒后 `runBackgroundLayoutRestore()` 只检查 `!tab.sessionId`（`useTerminalSessionRestore.ts:23`），于是把每个 tab 重建一遍。

放大成事故的三个配套缺口：

| 缺口 | 位置 | 后果 |
|------|------|------|
| daemon 会话无归属元数据 | `/api/sessions` 只回 `sessionId/status/pid/lastOutputAt` | 新实例想认领也没依据 |
| 无接管路径 | `SystemResourceSegment.tsx:222` `if (!location) return` | 无主会话点了没反应，只能看和杀 |
| reaper 恰好被守卫跳过 | `useOrphanSessionReconciler.ts:34` | `desktopClientCount !== 1` 整轮跳过（多实例正是本次情形），且首轮等 5 分钟、只 kill 不 adopt |

## 关键发现：join key 已经存在

`session_restore`（表名 `terminal_sessions`，位于共享的 `data.db`）已经存有 daemon 缺的那份归属元数据：

```
session_id → tab_id, pane_id, project_path, workspace_name, workspace_path,
             provider_id, launch_profile_id, cli_tool, runtime_kind, resume_id, custom_title
```

写入方 `collectRestorableSessions()`（`useSessionLayoutPersistence.ts:61`）用的正是 `tab.sessionId || tab.savedSessionId || tab.id`，即活 PTY 的 session id。**它跨 app 实例共享（SQLite），不像 webview 的 localStorage。**

因此根治不需要改 daemon 协议，只需把认领的匹配源从 webview 局部状态换成这张表。

## 第一部分：UI 接管（已实现）

- `usePanesStore.adoptSession(sessionId, meta)`：在当前布局活动 pane 建 tab，写 `savedSessionId + restoring = true`（与 `setBackgroundRestoreSession` 同形），交给 `TerminalView` 既有的 reattach 路径重连，**不新建 PTY**；会话已被引用时直接返回既有 tabId，可重复点击。
- `SystemResourceSegment`：面板打开时拉一次 `sessionRestoreService.load()`，无主会话的标题/工作区/cliTool 改从 `session_restore` 回填（不再一律「终端 \<pid\>」+「其他工作区」）；点击行时若无 tab 引用则先接管再聚焦。

覆盖：`usePanesStore.test.ts` 两例（接管成 savedSession / 已引用不重复建）。

### 第一部分的评审修正（已应用）

- `AdoptSessionMeta` 原先丢弃 `runtimeKind / ssh / wsl / providerSelection`，接管 WSL/SSH 会话后**下一次重建会在本地错误目录启动**。已补齐可得字段，并新增 `resolveAdoptRuntime()` 守卫：`local` 放行；`ssh` 仅在 `sshConfig` 可解析时放行；**`wsl` 一律拒绝**（`session_restore` 根本没存 distro/remotePath），拒绝时给出明确 toast 而非静默降级。
- 覆盖：`SystemResourceSegment.test.tsx` 三例（local / wsl 拒绝 / ssh 可解析才放行）。

## 已评审决议

2026-07-26 由 WSL Codex 独立只读评审（9 必修 / 5 开放），决议如下：

| 议题 | 决议 |
|------|------|
| 并发裁决机制 | **daemon lease**（否决 SQLite 条件 UPSERT+TTL：裁决方必须是拥有 PTY 与连接生命周期的一方，才能在 attach 前真正原子） |
| 多实例写权限 | 单一可写 owner，其他实例只读镜像 |
| 同 `resume_id` 命中多个活 PTY | 标冲突等人工，**不**按时间自动选（任何时间排序都不能证明哪条对话状态正确） |
| 无精确锚点的会话 | 不自动建 tab；**保留** UI 手动接管（用户显式点击 ≠ 自动认领，此张力不成立） |
| 首版默认 | feature flag 默认关闭灰度 |

## 第二部分：启动自动认领（按评审重写，尚未实现）

评审把体量从「3 步小改」推到「需要 daemon 侧原子 lease」。按依赖顺序分四阶段，前两阶段是纯逆向修复，不引入认领也应该做。

### 阶段 1 · 数据层逆向修复（无认领也该做）

1. **禁掉 `tab.id` 冒充 `session_id`** — `useSessionLayoutPersistence.ts:68` 的 `tab.sessionId || tab.savedSessionId || tab.id` 会把 tab id 写进 session_id 列，live registry 必须拒收。
2. **逐 leaf 持久化** — 终端 tab 可含多个分屏 leaf，现在每 tab 只存一行，而 `setBackgroundRestoreSession` 固定写**活动 leaf**，会把 PTY 接到错误的分屏格子。改为存稳定的 `terminal_pane_id`，按 `layout_id + tab_id + terminal_pane_id` 精确挂载。
3. **补全运行时指纹** — `session_restore.rs:30-39` 缺 WSL distro/remotePath 与 SSH host/user/port/remotePath。补齐后阶段 1 的 wsl 拒绝守卫才能放开。
4. **provenance 与 claim 分表** — 单主键 UPSERT 仍是最后写入者覆盖 `tab_id/pane_id`。会话来源（不可变，仅创建者写一次）与实例 claim（可变）拆开，60 秒周期保存不得改写归属。
5. **出生证据** — `created_at` 每次保存都被重置，不是 PTY 出生证据。创建成功返回前就持久化 session birth nonce + daemon instance id/startedAt。
6. **清理不再用「同一事务判活」** — daemon 列表是 SQLite 事务外的外部快照，消不掉 TOCTOU。只有拿到**完整且同一 daemon generation** 的快照才允许事务性删除；查询失败、空结果、generation 变化一律跳过删除。

### 阶段 2 · daemon 侧 lease（已实现）

daemon 侧的租约注册表与闸门已落地。**核心语义是「有租约才强制」**：没有任何实例 claim 过的会话，写入照旧放行——否则运行中的旧版客户端会在 daemon 升级瞬间全部失去输入能力（对应 CLAUDE.md「服务端新增的身份/协议字段必须可缺失」）。

| 面 | 实现 |
|----|------|
| 身份 | 请求头 `X-CC-Panes-Instance`，或 claim 请求体的 `appInstanceId`；WS 走 `?instanceId=`。缺失=匿名旧客户端 |
| 申请/续租 | `POST /api/sessions/{id}/claim`，TTL 缺省 30s、clamp 到 [5s, 300s]；同一 owner 重复调用即续租（幂等）；被别的实例持有 → 409 `SESSION_CLAIMED` 并带 `owner` |
| 释放 | `DELETE /api/sessions/{id}/claim`，仅持有者可释放；过期租约任何人可清 |
| 查询 | `GET /api/sessions/claims` → `sessionId → ownerInstanceId`（只返回有效期内的）。前端据此不对已被持有的会话提供接管 |
| 闸门 | `write` / `submit` / `resize` 三个 HTTP 写入路径 + WS 入站 `input` 与 Binary 帧。**订阅始终放行**（只读镜像是设计允许的） |
| 过期 | 纯 TTL，过期即视为无人持有，任何实例可接手 |
| 回收 | 挂在 `remove_session_activity` 上，会话拆除时活跃时间与租约一起丢弃，map 不随会话数增长 |

**实例身份与续租**（阶段 2 收尾，已实现）：

- `app_instance_id()`：进程级 `OnceLock`，格式 `app-<pid>-<启动纳秒>`。**随进程生成，重启即换新**——上个进程残留的租约靠 30s TTL 自然过期，不做持久化（评估过按数据目录持久化的方案，重启能立刻收回自己的会话，但崩溃残留的租约会一直归"自己"直到过期，取舍后选了简单的一侧）。
- 请求头在 `daemon_client.rs::request_with_timeout` 唯一收敛点注入，与 `Authorization` 同处，所有已鉴权请求自动带上；WS URL 带 `instanceId`。
- `DaemonTerminalBackend` 持 `owned_sessions` 集合：`create_session` 成功后立即 claim，`kill` 时移除。
- 续租线程间隔 10s（TTL 的 1/3，容忍两次连续失败）。线程只持 `Weak<owned_sessions>`——本类型是 `Clone` 的，用 `Drop` 停线程会让任意一个克隆析构就掐掉所有实例的续租；改成最后一个 backend 释放时 `upgrade()` 失败自然退出。
- 丢租（续租返回 409）时移出集合并告警，**不重试抢占**：两个实例交替抢租约会让输入交错。
- `adopt_session()` / `release_session()`：接管与「detach 但不 kill PTY」的回退路径。
- 客户端对老 daemon 的 404/405 一律视作"已授权"——那种 daemon 本来就不做裁决，拒绝写入只会让功能倒退。

未做（留给阶段 3/4）：租约与 `session_restore` 表的 provenance 关联、前端据 `/api/sessions/claims` 隐藏已被持有会话的接管入口。

### 阶段 3 · 启动认领轮

在 `restoreLiveDaemonSessionsFromBackend()` 之后、任何 `createSession` 之前插入。认领判据（**全部满足**才认领）：

- `daemon_generation` + `session_id` + origin leaf id 精确一致；
- 规范化路径比较**复用 `web/utils/projectIdentity.ts:6-12`** 的跨形式比较键，不得直接比较原始字符串，且 worktree 校验保留实际 worktree 根、不折叠为共同 Git 仓库；
- runtime 与 CLI 一致；非空 `resume_id` 只作一致性校验，不作匹配依据；
- 同一 leaf 命中多个活 PTY → 拒绝自动选择，标冲突。

### 阶段 4 · 时序屏障

`App.tsx:56-102` / `TerminalView.tsx:1569-1686` 的子级 effect 可能**早于**启动认领 effect 就建了 PTY，`setTimeout(3_000)` 封不住这个窗口。改法：挂载 AppShell 前完成一次启动恢复屏障，或让三个创建入口在 `createSession` 前 await 同一个 reconciliation promise 并立即复检。

### 开关与回滚

新增默认关闭、可热禁用的 `autoAdoptDaemonSessions`；自动接管来源要打标；支持 detach + release claim（解除挂载但不 kill PTY）的回退路径；迁移只增表/列，保证旧版本可忽略新数据。灰度需覆盖：双实例、全灭重启、split leaf、WSL、SSH、worktree、daemon generation 变化。

## 待办

- [x] 清理存量（孤儿 11 + 重复 19，释放约 11GB）
- [x] 第一部分：UI 接管
- [x] 第二部分交叉评审（WSL Codex 只读，9 必修 / 5 开放）
- [x] 第一部分评审修正：运行时指纹 + `resolveAdoptRuntime` 守卫
- [x] 阶段 1 · 逐 leaf 锚点（`terminal_pane_id` + `layout_id`，migration 26）
- [x] 阶段 1 · 禁 `tab.id` 冒充 `session_id`
- [x] 阶段 1 · 补全运行时指纹（`wsl_config` / `machine_name`），接管守卫放开 WSL
- [x] 阶段 1 · `save_sessions` 去掉 `DELETE FROM` 全表覆盖，改按 `session_id` UPSERT
- [ ] 阶段 1 · provenance / claim 分表（依赖阶段 2 的实例身份）
- [ ] 阶段 1 · 出生证据 birth nonce + daemon generation（依赖阶段 2）
- [ ] 阶段 1 · 死行剪枝（依赖阶段 3 的 daemon generation 一致快照）
- [x] 阶段 2 daemon lease（注册表 + 端点 + 写入闸门 + 回收，7 项测试）
- [x] 阶段 2 收尾：进程级 app_instance_id + 请求头/WS 注入 + create 时 claim + 10s 心跳续租（5 项测试）
- [x] 阶段 3 启动认领轮（`attachSessionToAnchor` + `adoptUnownedDaemonSessions`，默认关闭的 `autoAdoptDaemonSessions` 开关，6 项测试）
- [x] 写入被租约挡下时的用户提示（按会话去重 + 30s 冷却）
- [ ] 阶段 3 收尾：接管前查 `/api/sessions/claims`，隐藏已被他实例持有的会话
- [ ] 阶段 4 时序屏障

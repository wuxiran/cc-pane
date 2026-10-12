# 107 · 0.12.22 性能专项：多开 Claude Code 不卡、单窗格编译不拖垮整机

> 状态：**研究结论 + 实施方案**（2026-10-12，基线 `dev/v0.12.22@a313dd1d`）。
> 对照仓库已更新到：Orca `v1.4.224`（2026-10-10）、OpenCode `v2.0.27`（2026-10-12）、Codex `rust-v0.162.1`（2026-10-09）。
> 前置阅读：`docs/71-multi-pane-resource-contention.md`（A/B 类判据、已落地的流控与优先级）、`docs/bugs/daemon-socket-churn-terminal-stall.md`（0.12.21 修掉的"终端停住"）。
>
> 本文回答三个问题：① 多开 20–30 个 Claude Code 如何保证不卡；② 某个窗格开始编译大项目时如何不拖垮整机；③ 三家对照仓库最近两个月有什么值得抄。

---

## 0. 结论先行

| 问题 | 根因形状 | 0.12.22 要做的事 | 对照依据 |
|---|---|---|---|
| 多开不卡 | 渲染进程是单点：N 个挂载的 xterm、N 份轮询、N 个 WebGL 上下文都压在同一个 WebView2 主线程上（实测峰值 135% CPU / 1.7 GB）。本机 28 个 claude.exe **空闲时合计只有 77% 核**，CLI 本身不是主因 | **P1 隐藏视图停泊（parking）** + 隐藏 WebGL 上下文 LRU（≤6）+ 启动/恢复风暴信号量 | Orca §4/§7、OpenCode §2 |
| 编译不拖垮整机 | 子进程只被降到 BELOW_NORMAL，没有内存软限、没有 WSL 配额、没有"正在编译"的闸门；而且**肇事者在会话树外时 CC-Panes 完全看不见**（今天实测：Everything 索引器 874% CPU，用户以为是 CC-Panes 卡） | **P2 资源管理器**（含整机 Top 非会话进程、一键降优先级/EcoQoS）、**P3 Job 内存通知软限 + WSL systemd scope**、**P4 构建并行度环境注入** | Orca §2、docs/71 §9.2、Codex §6 |
| CLI 侧省资源 | Codex 运行中状态条 31 Hz 重绘、默认 6 个子 agent；Claude Code 无可注入项 | **P4 Codex 轻量注入**：`tui.animations=false`、`agents.max_concurrent_threads_per_session`、`shell_environment_policy.set.CARGO_BUILD_JOBS` | Codex §3/§5/§6 |
| 看得见再优化 | 发布版诊断只在 0.12.21 刚加；没有"N 个窗格 × 合成 TUI 重绘 + 一个窗格敲键"的回归门禁 | **P5 夜间规模性能门禁**（10/25/50 窗格，中位按键回显 ≤ 75 ms，渲染队列 ≤ 2 MiB） | Orca §6 |

三家对照里**没有任何一家限制自己子进程的 CPU/内存**（Orca 零、OpenCode 零、Codex 零）。CC-Panes 的 BELOW_NORMAL + CPU 权重已经领先；本专项要补的是"看得见 + 能干预 + 内存与 WSL 不裸奔"，而不是去追别人。

---

## 1. 现场实测（2026-10-12，本机 9950X 16C/32T，93.6 GB）

### 1.1 空闲基线（0.12.21 安装版，28 个 claude 会话 + 2 codex + 6 wsl）

| 进程族 | 数量 | CPU（32 核 = 3200%） | 内存 |
|---|---|---|---|
| claude.exe | 28 | 77%（≈2.7%/个） | 8.0 GB（≈285 MB/个） |
| msedgewebview2（CC-Panes） | 13 | 31% | 1.2 GB |
| cc-panes.exe | 1 | 5% | 123 MB |
| cc-panes-daemon | 1 | <1% | 38 MB |
| OpenConsole（每会话一个 ConPTY 宿主） | 28 | 0% | 320 MB |

结论：**CLI 的空闲代价是内存不是 CPU**。30 个会话 ≈ 8.5 GB 常驻，CPU 不到 1 个核。整机"卡"不来自空闲的 Claude Code。

### 1.2 后台性能采样（`performance*.jsonl`，11355 个样本，10/6–10/12）

| 指标 | 值 | 读法 |
|---|---|---|
| renderer 峰值 CPU | 135% | 单个 WebView2 渲染进程，B 类（UI 掉帧）的直接证据 |
| renderer 峰值私有内存 | 1.7 GB | 挂载 xterm 实例 × scrollback |
| maxPollingSessions | 32 | WebSocket 掉线后全部回退轮询（0.12.21 已修根因） |
| resync 事件 | 88 次 / 一周 | 每次全量重放 2–3 MB |
| maxTimerLagMs | 3097 ms | 主线程被占满 3 秒 |

0.12.21 的 keep-alive 修复已验证生效：daemon 端口 TIME_WAIT 从 2400+ 降到 0，常驻连接 33 条。resync / polling 两项预期在 0.12.21 之后大幅回落，**0.12.22 开发期要先收一周数据确认**，再决定 B 类还剩多少。

### 1.3 "现在就有点卡"的现场（10/12 晚）

整机 CPU 52–85%，肇事者 **Everything.exe 874% CPU / 2.7 GB**（NTFS 变更风暴后全量重索引），claude 合计 77%，cc-panes 5%。资源 popover 只列会话进程树，**对这种情况给不出任何线索**。这就是 §3.2 要加"整机 Top 3 非会话进程"的原因。

---

## 2. 对照仓库：值得抄的与不该抄的

### 2.1 Orca v1.4.224（较 docs/71 基线 59892a2f 领先 4246 提交）

| 该抄 | 位置 | 要点 |
|---|---|---|
| **隐藏视图停泊** | `terminal-hidden-view-parking.ts:8-21` | 隐藏 30 s 后卸载 xterm 实例；最近 5 min 内看过的保留，热实例上限 **6**（每 worktree 4）；PTY 继续跑，字节观察器只管 bell/title/完成；重挂载 ≈170 ms。**比我们现在"5 min 挂 WebGL / 30 min 休眠"激进一个量级** |
| 隐藏 WebGL 上下文 LRU | `terminal-webgl-hidden-retention.ts:7` | `MAX_RETAINED_HIDDEN_WEBGL_CONTEXTS = 6`；上下文丢失 60 s 内最多重试 3 次然后钉死 DOM。我们的预算是 8 个上下文但没有按"隐藏优先逐出" |
| 资源管理器 | `memory/collector.ts:280-354`、`windows-process-resource-collector.ts` | 一次 CIM 扫全表 → 按子树归属到窗格；CPU 用 tick 差分 + 进程创建时间防 PID 复用；**只在面板打开时每 2 s 采**；60 点内存 sparkline。动作只有 kill，**没有降优先级**——这是我们能领先的地方 |
| 恢复风暴信号量 | `history-reader.ts:58`、`daemon-pty-checkpoint-scheduler.ts:177` | 冷恢复重放并发 **1**（PrioritySemaphore，前台窗格插队）；checkpoint 并发 4、间隔 5 s、全量冷却 45 s、只拍脏会话；休眠拆除串行（注释说曾出现 ~100 个并发 sweep） |
| 停住看门狗 | `hang-watchdog-*` | worker 线程收心跳：2 s 一次，45 s 判挂，检查间隔 5 s；**间隔 >3× 视为系统睡眠不算挂**；只写 `main-thread-hang.json` 下次启动上报，**从不自杀** |
| 性能契约 | `config/scripts/terminal-perf-report-budgets.mjs:4-14` | 夜间 Playwright：10/25/50/100 窗格；中位按键回显 ≤25 ms、最差 ≤300 ms、恢复 ≤1 s、渲染队列 ≤2 MiB、丢弃积压 = 0。另有 11 个"操作次数/内存保留"契约测试 |

| 不抄 | 原因 |
|---|---|
| 杀进程 + `--resume` 式 agent 休眠（实验性，默认关） | 需要"done + 干净结束 + 无草稿 + 连续两 tick 签名相同"六重门控；Claude Code resume 在我们这边有身份回灌历史（docs/71 外的 issue #64 系列）。先做停泊，这条留给 0.12.23 评估 |
| 128 个 WebGL 上下文开关 | Chromium 命令行开关，WebView2/Tauri 拿不到；我们只能守住 ~16 的默认上限 |
| 把积压告警写进终端缓冲 | 会污染 `get_session_output`（docs/71 §3.3 已否决） |

### 2.2 OpenCode v2.0.27

| 该抄 | 位置 | 要点 |
|---|---|---|
| 输出落文件 + 有界尾部 | `shell.ts:323-333`、`tool-output.ts:13-14` | shell 输出直接流进文件，模型只看 2000 行 / 50 KiB 尾部；已退出 shell 最多留 25 个；7 天清扫。我们的 `plain_output` 有界保留已走这个方向，差"文件化" |
| 退出后 1 s 停读 | `cross-spawn-spawner.ts:315-327` | 应对 MSBuild / dotnet / Gradle 守护进程继承管道不放——否则"已退出"的窗格会挂住。**Windows 真实负载**，值得补 |
| 事件合批 | `publish-llm-event.ts:80`、`connection.ts:65` | 高频流 100 ms 合并，UI 侧 10–16 ms 批刷；慢订阅者直接断开让其重连（`event-feed.ts:64-68`），**绝不拖慢生产者** |
| 单一动画时钟 | `animation.ts:216-235` | 一个 16 ms interval，没有动画任务时自停。我们每个忙碌标签各自 CSS keyframes spinner 的成本可以这样收口 |
| 按事件刷新的 TTL 卸载 | `location-activity.ts:25,43` | 60 min 无事件卸载该项目的重状态，每分钟扫，拆之前重查一次 |

不抄：Bun `--smol`、Electron 启动项、LLM compaction 参数——与终端管理器无关。OpenCode **没有** PTY WebSocket 背压（`Queue.unbounded`），这一点我们已经领先。

### 2.3 Codex rust-v0.162.1

Codex 对自己跑的命令零资源限制（无 rlimit / nice / Job 限额），Windows 上 Job 只用 `KILL_ON_JOB_CLOSE | BREAKAWAY_OK`。宿主能做的全在注入面：

| 注入项 | 效果 | 风险 |
|---|---|---|
| `-c tui.animations=false` | 运行中状态条重绘 **32 ms → 1000 ms**，关 spinner / 标题 spinner / 欢迎动画 | 用户感知"没动画"；可做成设置默认开 |
| `-c agents.max_concurrent_threads_per_session=N` | 默认 6（V2：4−1），30 个实例 × 6 子 agent 会放大 | 影响 Codex 的并行能力，默认不改、只在"低配模式"下注入 |
| `-c shell_environment_policy.set.CARGO_BUILD_JOBS="8"`（及 `MAKEFLAGS`、`CMAKE_BUILD_PARALLEL_LEVEL`） | **唯一能进到 Codex 所跑命令里的手段**，直接限编译并行度 | 比 Job CPU 权重更"硬"，但也更可预期；给用户一个"编译并行度"滑杆 |
| `-c tui.auto_recap=false` | 失焦 30 min 后不再发一次模型调用 | 无 |
| 已注入的 `tui.terminal_title`、`tui.fullscreen_transcript` | ⚠️ 除 `tui.fullscreen_transcript` 外任何 `-c` 都会让 Codex **放弃共享后台 server、改用内嵌模式**（`daemon_startup.rs:94-144`） | 每实例多占内存，但整棵进程树留在窗格的 Job 里——对资源归属反而是**好事**，保持现状并写进 gotcha |

Codex 的 Job 在 `spawn_contained` 里用 `CREATE_SUSPENDED → assign → NtResumeProcess` 消掉 spawn-assign 窗口（`utils/pty/src/win/job.rs:129-213`），我们 `pty/job.rs` 的注释承认有"极小窗口"，可以照抄。

---

## 3. 实施方案（按优先级）

### P1 · 多开不卡：隐藏视图停泊 + 风暴信号量（B 类）

**目标**：30 个会话时渲染进程常驻 ≤ 600 MB、空闲 CPU ≤ 10%；切换标签 ≤ 200 ms。

| 项 | 落点 | 说明 |
|---|---|---|
| 停泊状态机 | `terminalBackgroundLifecycle.ts` 新增 `parked` 层 | 隐藏 **30 s** → 卸载 xterm（当前 5 min 只挂 WebGL、30 min 才休眠）。热实例上限 6（设置可调 2–12），LRU 逐出。恢复复用现有 recovery snapshot（checkpoint + delta，0.12.21 已带几何），不另造 headless emulator |
| 字节观察器 | `terminalHiddenWriteBuffer.ts` 旁路 | 停泊中只解析 bell / OSC 标题 / 完成信号，不喂 xterm。现有 hidden 预算（`terminalHiddenBudget.ts`）保持 |
| 隐藏 WebGL LRU | `terminalRendererController.ts` | 预算从"总数 8"改为"可见全给 + 隐藏保留 ≤6，按最近隐藏时间逐出"；上下文丢失 60 s 内最多重试 3 次后钉 DOM |
| 恢复风暴信号量 | `terminalRestoreQueue.ts` 升级 | 冷启动重放并发 **1**，前台窗格优先级插队（Orca PrioritySemaphore 77 行可直接移植）；checkpoint 上传并发 4、只拍脏会话 |
| 单一动画时钟 | `web/components/ui/*spinner*` | 忙碌标签 spinner 改共享 rAF/interval，无任务自停 |

**验收**：30 个会话、25 个隐藏，renderer 私有内存与 CPU 用 `summarize-performance.mjs` 对照 0.12.21 基线；切标签 p95 ≤ 200 ms。

### P2 · 看得见：资源管理器 2.0（A 类可见性，docs/71 阶段二）

| 项 | 落点 | 说明 |
|---|---|---|
| 整机 Top 非会话进程 | `system_stats_service.rs` + `SystemResourcePopover.tsx` | popover 新增"会话之外"一栏：整机 CPU > 阈值时列 Top 3（名称 / CPU / 内存），今天的 Everything 案例一眼可见 |
| 边沿触发采样 | `SystemResourceSegment.tsx` | 整机 CPU ≥ 60% 持续 10 s 才开 per-session 采集，回落即停（docs/41 教训：别让监控本身吃资源） |
| 标签页琥珀徽标 | 标签栏 | 会话树 CPU ≥ 200% 或内存 ≥ 4 GB 时点亮，点击打开 popover 定位 |
| 低于杀进程的干预 | 新命令 `set_session_resource_policy` | 调已有但无人调用的 `PtyProcess::set_resource_policy`（`pty/mod.rs:170-197`）：Below Normal ↔ Normal、CPU 权重 1–9、**EcoQoS**（`PROCESS_POWER_THROTTLING_EXECUTION_SPEED`，Windows 11 的"效率模式"，对编译类负载最有效）。daemon 加同名路由 |
| 策略结果回传 | `PolicyOutcome` → 前端 | 现在只 `tracing::warn!`；按 `resource_policy.rs:86` 的注释补到会话状态里，popover 显示"已降级：原因" |
| CPU 归属按最近祖先 | `build_resource_tree_from_snapshot` | 修 docs/71 §2.9 的迭代顺序漂移，加双会话嵌套测试 |

### P3 · 编译不拖垮：内存软限 + WSL 配额（A 类执行面，docs/71 A-1/A-2/A-6）

| 项 | 落点 | 说明 |
|---|---|---|
| Job 内存**通知**限 | `pty/job.rs` | 用 `JobObjectNotificationLimitInformation`（`JOB_OBJECT_LIMIT_JOB_MEMORY_HIGH` 通知型）而非硬限：超限只发事件 → 徽标 + 通知"该窗格已用 X GB"，**不杀、不让 build 莫名失败**（docs/71 §7.3 要点 1）。默认阈值 = 物理内存 25%，可调 |
| WSL systemd scope | `wsl_codex.rs` 包 `systemd-run --user --scope -q -p CPUWeight=20 -p MemoryHigh=<25%>` | docs/71 §7.2 已实测可用、无需 root；探测 + 缓存 + 不可用时降级 `nice` 且**对用户可见** |
| WSL 真实读数 | `system_stats_service.rs` | 会话为 WSL 时读 cgroup `memory.current` / `cpu.stat`，替换恒 7.9 MB 的假值（A-6，与 A-2 同期做） |
| spawn-assign 窗口 | `pty/job.rs` | 照 Codex `CREATE_SUSPENDED → AssignProcessToJobObject → NtResumeProcess` |
| 退出后 1 s 停读 | `pty/mod.rs` 读线程 | 子进程退出后管道 1 s 内未 EOF 则放弃读取（MSBuild/Gradle 守护进程继承管道） |
| 构建并行度注入 | 设置"编译并行度"（默认 = 核数 − 8，32 核 → 24） | Codex：`-c shell_environment_policy.set.CARGO_BUILD_JOBS`；Claude/Grok/所有 CLI：直接注入进程环境 `CARGO_BUILD_JOBS` / `MAKEFLAGS=-jN` / `CMAKE_BUILD_PARALLEL_LEVEL` / `UV_THREADPOOL_SIZE`。这是三家都没有、但对"编译拖垮整机"最直接的手段 |

**验收**：单窗格 `cargo build --workspace` 期间，另一窗格按键回显 p50 ≤ 75 ms；三窗格并发编译时浏览器可正常操作；编译总耗时上升 ≤ 15%。

### P4 · CLI 侧轻量化注入

| CLI | 注入 | 默认 |
|---|---|---|
| Codex | `tui.animations=false`、`tui.auto_recap=false` | **开**（设置可关） |
| Codex | `agents.max_concurrent_threads_per_session=2` | 关；"低配模式"下开 |
| 所有 | 编译并行度环境变量（见 P3） | 开 |
| Claude Code | 无可注入项；只能靠 Job 与环境变量 | — |

### P5 · 回归门禁：夜间规模性能测试

| 项 | 说明 |
|---|---|
| 场景 | 10 / 25 / 50 个窗格跑合成 TUI 重绘（768 KiB/窗格），在一个前台窗格敲键 |
| 指标 | 中位按键回显 ≤ 75 ms、最差 ≤ 300 ms；渲染队列 ≤ 2 MiB；丢弃积压 = 0；切标签 ≤ 300 ms；恢复 ≤ 1 s；定时器漂移 ≤ 250 ms |
| 落点 | 复用 `scripts/smoke-v13-flood-only.mjs` / `stress-v13-long-layouts.mjs` 的驱动，新增 `scripts/perf-scale.mjs`；CI 夜间 job，报告进 `docs/diagnostics/` |
| 内存保留契约 | vitest：隐藏窗格预算、停泊后 xterm 实例数、WebGL 上下文数 ≤ 6 的断言 |

---

## 4. 不做 / 推迟

- **全局启动闸门**（docs/71 A-3）：Orca 与 OpenCode 都没有、也没证据证明需要；用户主动开 10 个窗格编译是其选择，P3 的并行度注入 + 优先级已足够。推迟。
- **进程数上限**（A-4）：fork 炸弹不是真实负载形状。不做。
- **杀进程式 agent 休眠**：见 §2.1 不抄表。0.12.23 评估。
- **Claude Code 空闲 CPU**：实测 2.7%/个，不值得动。

---

## 5. 排期建议

| 周 | 内容 |
|---|---|
| 第 1 周 | 先收 0.12.21 一周 `performance*.jsonl` 定 B 类余量；P2 的"整机 Top 非会话进程" + 策略回传（小、独立、立刻有感）；P3 的编译并行度注入 |
| 第 2 周 | P1 停泊 + WebGL LRU + 恢复信号量 |
| 第 3 周 | P3 Job 内存通知 + WSL scope + 真实读数；P2 徽标与干预档位 |
| 第 4 周 | P5 门禁、文档、CHANGELOG |

每项合并前照 docs/71 的惯例在本文 §3 表格上标"已落地 / 落点"，不另开文档。

---

## 6. 新增 Known Gotcha 候选

> **整机卡 ≠ CC-Panes 卡**：资源 popover 只列会话进程树，Everything / Defender / Windows Search / Docker 这类会话外肇事者完全不可见（2026-10-12 实测 Everything 874% CPU 被当成 CC-Panes 卡）。排障先看整机 Top 进程，再看会话。

> **给 Codex 任何 `-c`（除 `tui.fullscreen_transcript`）都会让它放弃共享后台 server 改用内嵌模式**：我们注入了 `tui.terminal_title`，所以 CC-Panes 下的 Codex 永远是内嵌模式。副作用是每实例多占内存；好处是整棵进程树留在窗格 Job 里。不要为了"省内存"把 `-c` 挪进 `CODEX_HOME/config.toml`——那会让所有实例共享一个 server，资源归属失真。

> **Windows 上 Job Object 的内存限制要用通知型**：`JOB_OBJECT_LIMIT_JOB_MEMORY` 是硬限，超限分配直接失败，用户看到的是莫名其妙的 build 失败；`JobObjectNotificationLimitInformation` 只发事件。CPU 同理用 WEIGHT_BASED 不用 HARD_CAP（docs/71 §6）。

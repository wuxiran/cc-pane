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
| 总量失控 | 优先级只是"让路"，10 个窗格同时编译依然 100%；`rg` 短促满核躲过优先级 | **P6 资源门禁**：重负载经 daemon 拿槽位、共享构建 Job 设总上限、rg 限线程 | docs/71 A-3 的正确形态 |
| 本机算力不够 | 一个 `cargo build --workspace` 就 99%，再多的让路也救不了 | **P7 编译卸载到第二台机器**：短期用已有 SSH 运行时把重项目的会话整个开到远端；中期门禁把 `cargo check/test/clippy` 这类"只要结果不要产物"的命令同步源码后在远端跑、输出流回窗格 | 现有 `ssh_*_service` |
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

### P3b · 线程模型：不做线程池，收 tokio worker，评估 daemon 侧 headless 模拟

实测（2026-10-12，36 个会话）：daemon 146 条线程、app 126 条、web 68 条，**全部处于 Wait**；10 秒内只有 11 条线程跑过、最忙的一条 47 ms；daemon 空闲 CPU 1.2% 的一个核。每会话固定 3–4 条阻塞线程（`cc-panes-pty-reader` / `-batch` / `-wait` / `-writer`），合批线程用 `recv_timeout` 不是轮询。

| 项 | 结论 | 落点 |
|---|---|---|
| 读线程并成 IOCP 事件循环 / 线程池 | **不做**。省的是百余条睡眠线程 + 几 MB 栈，换的是 ConPTY 重叠 IO 重写与新的边界 bug；daemon 不是卡的来源 | — |
| tokio worker 数 | 默认 = 核数（本机 32）。daemon / cc-panes-web 收到 **4–8**，减少空闲定时器唤醒与线程数 | `cc-panes-daemon/src/main.rs:206`、`cc-panes-web/src/main.rs:217` 的 `#[tokio::main]` 改 `worker_threads` |
| daemon 侧 headless 终端模拟 | **评估项（0.12.23）**。停泊（P1）后字节不进 xterm，状态靠 checkpoint + delta；Orca 更进一步在 daemon 里跑 headless 模拟器，重挂载 170 ms 且无需重放。Rust 侧候选 `vt100` / `alacritty_terminal`。这是"后端多线程"唯一值得用的地方：把隐藏终端的 VT 解析整体搬出渲染进程的单条 JS 主线程 | 新 crate 或 `cc-panes-core/src/pty/` 下模块；先做 spike 量 36 会话的内存 |
| 序列化 / checkpoint 上传下放 Web Worker | SerializeAddon 必须在主线程；压缩、分块、上传可下放。**先用 `[terminal-diag]` 日志确认主线程占比再决定** | `terminalCheckpointUpload.ts` |

### P6 · 资源门禁：编译 / grep 等重负载统一经 CC-Panes 调度（新想法，2026-10-12）

**想法**：CLI 代理在窗格里跑 `cargo build` / `npm run build` / `rg` 时，不是各自撒开跑，而是经 CC-Panes 的门禁拿到一个"重负载槽位"，在限定的 CPU/内存配额内完成；没拿到槽位的排队，排队状态对用户可见。

**为什么现有机制不够**：Job 的 BELOW_NORMAL + CPU 权重是"竞争时让路"，不是"总量上限"。10 个窗格同时编译，每个都让路，整机依然 100%；grep 一类短促但满核的任务更是躲过优先级就打满所有核。门禁解决的是**跨会话总量**，是 docs/71 A-3 "通用启动闸门"的正确形态——不是限制开窗格，而是限制同时跑的重负载。

**拦截点（按可靠性排序）**：

| 方式 | 覆盖 | 做法 | 风险 |
|---|---|---|---|
| ① **环境变量注入**（已在 P3） | cargo / make / cmake / rayon / node / rg | 会话环境里注入 `CARGO_BUILD_JOBS` `MAKEFLAGS=-jN` `CMAKE_BUILD_PARALLEL_LEVEL` `RAYON_NUM_THREADS` `UV_THREADPOOL_SIZE`，以及 **`RIPGREP_CONFIG_PATH`** 指向 CC-Panes 生成的 rg 配置（`--threads=N`、`--max-columns`）。Claude Code 的 Grep 工具调的是它自带的 rg，同样读这个环境变量 | 只限并行度不限总量；工具若 `--no-config` 则绕过 |
| ② **PATH 垫片（shim）** | 任何按名调用的工具：cargo rustc rg npm pnpm tsc make cmake ninja go dotnet msbuild | 会话 PATH 最前面放 `~/.cc-panes/shims/`，内有 Rust 写的小 exe（不用 .cmd，.cmd 会破坏引号与退出码）。垫片：向 daemon 申请槽位（Unix socket / 已有 REST）→ 拿到后把自己放进"构建 Job"（嵌套 Job，Windows 8+ 允许）→ `exec` 真实二进制并原样转发 stdin/stdout/信号/退出码 | PATH 被 CLI 自己的 login shell 重写则失效（WSL 的 `appendWindowsPath` 同类问题，docs/71 §7.4）；垫片本身是新的进程层 |
| ③ Claude Code `PreToolUse` hook 改写 Bash 命令 | 仅 Claude | 在命令前加 `cc-panes-ctl run --gate --` | 脆弱：复合命令、管道、`cd &&`、heredoc 都要正确包裹；不推荐做主路径 |

**门禁本体（daemon 内）**：

- **槽位**：`heavy_job_slots` 默认 `max(1, 核数 / 8)`（32 核 → 4），设置可调；按会话公平（同一会话不占两个槽）。等待方收到一行带外提示（走已有 `{"type":...}` 控制消息，不写进终端缓冲，避免污染 `get_session_output`），窗格标签显示"排队中 2/4"。超时（默认 5 min）放行并记日志，**永不无限期阻塞 agent**。
- **配额**：所有持槽进程放进一个共享的 **"构建 Job"**（嵌套在各自会话 Job 之下）：`JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP` 对整组设总上限（默认 75%，即给 UI 留 8 核）、或 **CPU sets** 把构建钉在核 8–31；内存走通知型软限（P3）。WSL 侧对应 `systemd-run --scope -p CPUQuota=` 的一个共享 slice。
- **grep 特判**：短任务不排队（排队比跑完还慢），只限线程数（①）+ 进构建 Job 吃总上限。判据：命令名在白名单 `rg grep fd find`。
- **可见性**：资源管理器（P2）多一栏"构建队列"：谁持槽、跑了多久、谁在排。
- **killswitch**：全局开关 + 每会话"不受门禁"标记（例如用户正在盯着的前台窗格）。

**与 Codex 的交互**：Codex 的命令由其内嵌 server 起（见 §2.3 gotcha），进程树在会话 Job 里，PATH 与环境变量都继承，①② 均生效。`shell_environment_policy` 可能清洗环境——需确认默认 `inherit = "all"` 下 `RIPGREP_CONFIG_PATH` 能传到。

**验收**：10 个窗格同时 `cargo build`，整机 CPU 稳定在上限附近、UI 按键回显 p50 ≤ 75 ms；排队窗格 5 分钟内全部完成；`rg` 在 30 会话场景下单次不超过 N 线程；关闭门禁后行为与 0.12.21 完全一致。

**分期**：① 随 P3 先上（零风险）；门禁本体 + 嵌套构建 Job 第二步；垫片 ② 最后，且先只做 cargo / npm / rg 三个。

### P7 · 编译卸载到第二台机器（新想法，2026-10-12）

**想法**：本机只负责编辑、渲染和跑 agent，编译 / 测试 / 大 grep 这类重活丢到一台辅机上做，本机不再动不动 99%。

**两条路，先后不同**：

| 路 | 做法 | 现在能不能用 | 代价 |
|---|---|---|---|
| **A · 整个会话开到辅机** | 用 CC-Panes 已有的 SSH 运行时（`ssh_terminal_service.rs`、`ssh_machine_service.rs`）把重项目的 Claude/Codex 会话直接起在辅机上，仓库也放辅机；本机只是渲染端 | **今天就能用，零代码**。这是对"动不动 99%"最快的解法 | 仓库要在辅机上（或辅机挂本机共享盘，慢）；编辑器也得看辅机的文件（VS Code Remote-SSH 配合）；辅机 OS 得跟构建目标一致（Tauri Windows 包只能在 Windows 上打） |
| **B · 命令级卸载** | 门禁（P6）判定某条命令"只要结果不要产物"（`cargo check/test/clippy`、`tsc --noEmit`、`vitest`、`rg`）时：把本机工作树的**未提交差异**同步到辅机同名 worktree → 远端执行 → stdout/stderr/退出码流回本窗格，agent 无感 | 要做：源码同步 + 远端执行 + 路径映射 + 产物回传规则 | 复杂度在同步与路径，不在执行 |

**B 的关键设计**：

- **同步用 git 而不是 rsync**：`git diff --binary HEAD` + 未跟踪文件列表 → 远端 `git fetch` 到同一提交后 `git apply`；或者直接 `git bundle`。Windows 上没有可靠的 rsync，而两端本来都有 git。每次只传差异，秒级。
- **路径映射**：本机 `D:\04_workspace_rust\cc-book` ↔ 辅机 `/srv/build/cc-book`（或 Windows 辅机的 `D:\build\cc-book`），在 SSH 机器配置里登记一次；错误输出里的路径要**反向映射**回本机，否则 agent 读到的 `file:line` 全是辅机路径，会去改不存在的文件。
- **产物规则**：默认不回传；白名单命令才回传（例如 `npm run build` 的 `dist/`）。Rust 的 `target/` 永远不传。
- **缓存**：辅机上 `sccache` / cargo 增量缓存常驻，第二次起比本机还快；JS 侧 Nx / Turborepo 远端缓存同理。
- **判定什么该卸载**：门禁已经知道命令名；加一条"本机负载 > 阈值 或 队列非空 → 优先远端"。前台用户正在等的交互式命令不卸载。
- **失败回退**：辅机不可达 / 同步失败 → 本地照常跑，并在资源管理器里标"已回退本地"，不能静默。
- **与 P6 的关系**：P7 是 P6 的一个"槽位类型"——门禁把本机槽位和远端槽位放在同一个调度器里，而不是两套。

**执行后端：Docker 作为第三种目标（想法三，2026-10-12）**

路 B 的"远端执行"抽象成一个 `HeavyRunTarget`，三种实现共用同步与路径映射：

| 目标 | 形态 | 资源上限怎么来 | 适合谁 |
|---|---|---|---|
| `local` | 本机直接跑，进构建 Job | Job CPU 硬上限 / CPU sets（Windows），systemd scope（WSL） | 没有辅机也没有 Docker 的用户 |
| `docker`（**本机 Docker Desktop**） | `docker run --rm --cpus=N --memory=XG --cpuset-cpus=8-31 -v <源码卷> <toolchain 镜像> <cmd>` | **cgroup 硬限，是 Windows 上最可靠、最现成的"总量上限"**——比 Job 的 HARD_CAP 语义清楚，比 WSL scope 不依赖发行版 systemd | 已装 Docker Desktop 的用户（本机实测就有 `docker-desktop` 发行版）；CPU 还是本机的，但**绝对出不了上限** |
| `docker` via `DOCKER_HOST=ssh://辅机` | 同一条命令，Docker 自己通过 SSH 走到辅机的 daemon | 辅机的 cgroup | 有辅机的用户，**与本机 Docker 共用一套实现**，这是选 Docker 当后端的主要理由 |
| `ssh` | 裸 SSH 执行（P7 路 B 原方案） | 辅机 systemd scope / 不限 | 辅机没装 Docker |

Docker 的几个硬约束，决定它只能是"之一"而不是唯一：

- **源码进容器不能走 Windows 盘的 bind mount**：`D:\...` 挂进 WSL2 容器是 9P 协议，`cargo check` 这种海量小文件读会慢 5–10 倍。必须把源码放在**命名卷 / WSL 文件系统**里，用与路 B 相同的 git 差异同步进去（`docker exec … git apply`）。这反而让 docker 与 ssh 两条路的同步层完全一致。
- **只能产 Linux 产物**：`cargo check/test/clippy`、`tsc`、`vitest`、`rg` 没问题；Tauri Windows 包、WebView2 相关测试不行。Windows 容器理论可行但镜像 10 GB 级，不做。
- **工具链镜像按项目**：需要 `Dockerfile.heavy` 或从仓库的 `Dockerfile` / `rust-toolchain.toml` / `.nvmrc` 推导；首次拉镜像和冷缓存慢，所以卷要常驻（`target/`、`node_modules/`、sccache 都在卷里，第二次起很快）。
- **VM 天花板**：Docker Desktop 的 WSL2 VM 受 `.wslconfig` 的 `processors` / `memory` 约束——docs/71 §7.4 的 WSL 配置面板在这里直接复用，"给 Windows 留 8 核"就是一行 `processors=24`。
- **路径映射同样必需**：容器内 `/work/cc-book/src/x.rs:12` 要映回 `D:\04_workspace_rust\cc-book\src\x.rs:12`，否则 agent 去改不存在的文件。

**结论**：Docker 不是第四个想法，而是 P7 路 B 最好的默认执行后端：没有辅机时它给本机一个真正的硬上限；有辅机时改一个 `DOCKER_HOST` 就切过去。没装 Docker 的用户落到 `local`，行为与今天一致。

**辅机 CPU 弱（例如那台 5090 机）还值不值得卸载？** 值得，但要分命令。编译是纯 CPU 活，GPU 帮不上；弱 CPU 意味着同一条 `cargo check` 可能慢 2–3 倍。判断标准不是"谁更快"，而是"谁在等"：

| 命令 | 谁在等结果 | 建议目标 |
|---|---|---|
| `cargo check` / `tsc --noEmit`（agent 改一行就跑一次的内环） | agent 在等，用户在等 agent | **本机门禁槽位**（P6），慢 1 秒都有感 |
| `cargo test` / `clippy` / `vitest` 全量 / `cargo build --release` | agent 在等，但一跑几分钟 | **辅机**，本机不被占死比快两分钟重要 |
| `rg` 全仓 | agent 在等，秒级 | 本机限线程，不卸载（同步开销比跑完还久） |
| 夜间性能门禁（P5）、发版打包 | 没人在等 | 辅机或 CI |

门禁按命令名 + 预估时长（可以记上次耗时）决定去向，并在资源管理器里显示"本次为何去了辅机"。另外弱 CPU 机的 `target/` 常驻缓存 + sccache 可以把差距缩到 1.5 倍以内。

**要不要做成 Jenkins 那样的系统？** 不做 Jenkins，但抄它的四个概念：

| Jenkins 概念 | 我们对应 | 说明 |
|---|---|---|
| Executor + 节点标签（`linux` / `windows` / `gpu`） | `HeavyRunTarget` 带 `labels` 与并发容量 | 门禁按命令需要的标签选目标；Windows 打包只去 `windows` 节点 |
| 构建队列 + 优先级 | P6 的槽位队列 | 前台窗格 > 后台 agent > 夜间任务 |
| 工作区 per job | 辅机 / 卷里的同名 worktree + git 差异同步 | 不重新 clone，只 apply 差异 |
| 控制台实时输出 | 输出流回本窗格 | agent 当作本地命令在跑 |

不抄的：Pipeline DSL、插件体系、Web UI、制品库——那是"按提交触发的 CI"的需求，延迟以分钟计（排队 + checkout + 环境准备）；agent 的内环需要秒级反馈，**CI 的延迟模型对 agent 不可用**。两者分工：P6/P7 是交互式执行器，服务 agent；CI 用现成的 GitHub Actions self-hosted runner 装在 5090 机上，服务 P5 夜间门禁与发版——自己造 Jenkins 没有收益。

**OS 匹配**：Rust/TS 的 check、test、clippy、vitest 跨 OS 基本等价，可以用 Linux 辅机；`cargo build` 产 Windows 包、WebView2 相关测试必须 Windows 辅机（或辅机上的 Windows 虚拟机）。

**验收**：在本机 `cargo check` 期间整机 CPU 不超过 20%；远端往返（同步 + 执行 + 回传）比本地慢不超过 30%；辅机断网时命令自动回退本地且窗格可见。

**分期**：A 立即可用，写进手册即可；B 在 P6 门禁本体之后做，先只做 `cargo check/test/clippy` + `vitest` 四条白名单。

### P6/P7 的交付形态：可选开启的 skill + `cc-panes-ctl run`，默认不生效

**原则**：没有辅机、不想要门禁的用户，装了新版后行为与 0.12.21 完全一致。所有重负载调度都是**可选层**，不是基础设施强加的。

| 层 | 内容 | 默认 |
|---|---|---|
| **设置 → 性能**（新段） | 三个独立开关：`资源门禁`（本机槽位 + 构建 Job 总上限）、`编译并行度注入`（环境变量）、`辅机卸载`（选一台已登记的 SSH 机器 + 路径映射 + 白名单命令）。任一关闭则对应路径直通 | 门禁 **关**、并行度注入 **开**（只限并行度，无副作用）、辅机 **关** |
| **`cc-panes-ctl run [--heavy] -- <cmd>`**（新子命令，`cc-panes-ctl/src/cli.rs`） | agent 侧唯一入口。按设置决定：直通 / 本机排队拿槽进构建 Job / 同步到辅机执行并反向映射路径；辅机不可达自动回退本地并打标。三个开关全关时**就是 exec**，零开销 | — |
| **skill `ccpanes-heavy-run`**（`src-tauri/resources/claude-bundle/default-skills/heavy-run.md`，同步到 skill-market） | 教 agent：编译 / 测试 / 全仓 grep 一类重命令经 `cc-panes-ctl run --heavy --` 跑；短命令和交互式命令不经它。**只在用户打开"资源门禁"或"辅机卸载"任一开关时才注入会话**，否则 agent 根本看不到这个 skill，不会多一层 | 随开关启停 |
| **Claude Code `PreToolUse` hook**（可选） | 开关打开时由 CC-Panes 代写 hooks：Bash 命令匹配 `cargo (build|check|test|clippy)|npm run (build|test)|vitest|rg ` 则自动包上 `cc-panes-ctl run --heavy --`。用于 agent 忘了用 skill 的兜底；复合命令（管道 / `&&` / heredoc）**不改写**，宁可漏不可错 | 关，"门禁"开关下的二级选项 |

**为什么 skill 而不是只做 PATH 垫片**：垫片是无差别拦截，对不想要的用户是负担，且 WSL/login shell 重写 PATH 时静默失效；skill + ctl 是**合作式**的——agent 知道自己在排队、知道命令在辅机跑、能把"已回退本地"告诉用户，也能被用户一句话关掉。垫片留作第三步，只给明确要"所有工具无脑接管"的用户。

**Codex / Grok 的对应**：Codex 用 `-c` 注入 `shell_environment_policy.set.*`（环境变量层）即可，skill 同样可装进 `CODEX_HOME/skills`；Grok 无 skill 机制，只吃环境变量层。

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

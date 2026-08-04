# 71 · 多窗格资源争抢：一个窗格能拖垮整机

> 状态：**调查完成，待修**
> 触发场景：任一窗格里跑 `cargo build` / `rg` 扫大目录 / `npm run build`，整机 CPU 与内存被吃满，所有窗格连带整台机器一起卡。
> 关联：`docs/41-wallpaper-perf-investigation.md`（轮询扫描器把 28.6 核打满的先例）、`docs/46-frontend-styleguide.md`（琥珀约定）、`docs/17-persistent-terminal-daemon.md`

---

## 1. 现象与同形陷阱

用户说"卡"的时候，至少有三种**症状高度相似、治法完全不同**的情况。先分清，否则一定修错地方。

| 类型 | 判定方法 | 根因所在 | 本文 |
|------|----------|----------|------|
| **A. 整机资源被吃满** | 任务管理器整机 CPU/内存高位；**与 CC-Panes 无关的程序也卡**（浏览器、编辑器） | 子进程无任何资源约束（第 2 节） | ✅ 主题 |
| **B. 前端渲染卡顿** | CC-Panes UI 掉帧/滚动迟滞，但**整机 CPU 不高**；通常伴随某个窗格在疯狂刷屏 | xterm 写入链路缺背压、后台标签不暂停（第 3 节） | 附带调查 |
| **C. app 假死 / 白屏** | 窗口完全无响应或永久 `Loading CC-Panes...` | 已知 gotcha：Vite watch 事件风暴、失效 WebView 的 emit 自放大洪水 | 见 CLAUDE.md |

**同形陷阱**：A 和 B 都表现为"开了几个窗格之后就卡"，但 A 的元凶是子进程（cargo/rg），B 的元凶是 CC-Panes 自己的渲染线程。**判据是整机 CPU**：整机高 = A，整机不高但 UI 掉帧 = B。搞反了会去优化渲染，而实际是编译器在吃 32 个核。

---

## 2. 现状（A 类：资源争抢）

### 2.1 PTY 子进程资源限制：完全没有

`cc-panes-core/src/pty/job.rs:40-47`：

```rust
let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
```

`JOBOBJECT_EXTENDED_LIMIT_INFORMATION` 其余字段全部 `::default()`（零值 = 不生效），所以：

- ❌ 无 `JOB_OBJECT_LIMIT_JOB_MEMORY` / `PROCESS_MEMORY`
- ❌ 无 `JOB_OBJECT_LIMIT_ACTIVE_PROCESS`
- ❌ 无 `JOB_OBJECT_LIMIT_PRIORITY_CLASS` / `AFFINITY`
- ❌ 无 `JobObjectCpuRateControlInformation`（需另一次 `SetInformationJobObject` 调用，全仓零命中）

`spawn_pty`（`cc-panes-core/src/pty/mod.rs:133-195`）只做 cwd 净化 + env 增删，assign Job 在 `:170-181`，之后**没有**任何 `SetPriorityClass` / `SetProcessAffinityMask` / Unix `nice` / `setrlimit` / cgroup。全仓 grep `SetPriorityClass|SetProcessAffinityMask|nice` 零命中。

> **Job Object 现在的唯一职责是"宿主暴毙时清树"，它不是资源闸门。** 看到 `job.rs` 里有 Job Object 就以为进程被限住了，是本仓库最容易踩的误读之一。

### 2.2 并发闸门：没有全局的

只有三处**局部**限流，都不管用户开窗格：

| 位置 | 限的是什么 | 为什么不解决本问题 |
|------|-----------|-------------------|
| `web/components/panes/terminalRestoreQueue.ts:3` | `DEFAULT_MAX_RESTORE_LAUNCHES = 3` + 45s 超时 | **仅崩溃/重启后恢复标签**，手动开标签与 `launch_task` 都绕过 |
| `src-tauri/src/services/terminal_daemon_bridge_reliability.rs:38` | 到 daemon 的**连接**并发（默认 4） | 与子进程资源无关 |
| `src-tauri/src/services/orchestrator_service.rs:744` | `StartLocks::acquire(profile.id)`，per-profile 串行 | 防重复启动，不是全局上限 |

无 `MAX_SESSIONS`、无"同时编译数量"限制、`launch_task` 路径无 semaphore。**十个窗格同时 `cargo build` 是被允许的。**

### 2.3 资源采集：已经很完整，不需要重造

后端（sysinfo 0.33，`cc-panes-core/Cargo.toml:36`）：

- `cc-panes-core/src/services/system_stats_service.rs` — 整机 `global_cpu_usage`（:267）；Windows 走 Toolhelp 快照建 PID 拓扑再用 sysinfo 补细节（:189, :330 fallback）
- `cc-panes-core/src/models/system_stats.rs:22-53` — `SessionResourceUsage { session_id, root_pid, cpu_percent, memory_bytes, process_count }` + `OrphanProcessInfo` + `ResourceTree`
- `src-tauri/src/commands/system_stats_commands.rs:41-64` — `get_resource_tree` / `get_system_stats` / `kill_orphan_processes`

**per-session 的 CPU/内存/进程数已经全都有了。** 阶段二不需要新采集器。

### 2.4 归因可见性：数据有，但藏在 popover 里

- 整机数据：`web/components/statusbar/SystemResourceSegment.tsx:27,115` — `POLL_INTERVAL_MS = 3_000` **常驻轮询**（`document.hidden` 时暂停）
- per-session 明细：`SystemResourcePopover.tsx` 的 `refreshResourceTree` — **只在 popover 打开时**才 3s 轮询

结果是：**卡的时候，用户得先自己想到去点状态栏那个 popover**，才能知道是哪个窗格在肇事。而机器卡顿时恰恰最不想点东西。标签页上没有任何资源徽标。

**已补（2026-08-02）：popover 里能看到"底下挂了什么"。** 此前每行只显示 CPU/内存两个数——它们**本来就是整棵进程树的聚合**（`system_stats_service.rs` 的 `descendants_including` + `aggregate`），但 UI 不展示构成，"只有 claude 自己"和"claude + 一个 cargo build"完全同形，用户没法判断该不该信这个数。现在：

- 折叠态显示进程数徽标（`processCount > 1` 才显示，避免每行挂个无信息量的 `1`）
- 展开后按内存降序列出各进程（name / PID / CPU / 内存，command 作 tooltip）
- 明细上限 24 条，超出部分聚合成 `truncated` 回传并显式渲染"另有 N 个进程"——**不静默截断**，否则"前 24 条"和"一共 24 条"又是一组同形

新增模型 `SessionProcessInfo` / `TruncatedProcessSummary`（`models/system_stats.rs`）。前端类型里 `processes` / `truncated` 都是可选的：运行中的旧 daemon 不返回这两个字段，缺失时退回成"没有可展开的东西"，不画假箭头。

仍未做：标签页上的资源徽标（不打开 popover 就能看见谁在肇事），以及本节开头说的"卡的时候主动说"。

### 2.5 管控手段：只有"全杀"这一档

- `kill_orphan_processes` — 孤儿进程批量终止（`SystemResourcePopover.tsx:197-240`，带二次确认 `orphanKillArmed`）
- `stop_runner` — `runner_service.rs:253-259` 走 `kill_process(root_pid)`

**没有"这个窗格在吃 CPU，先降它优先级"这一档。** 想让编译慢一点给 UI 让路，唯一办法是杀掉它重来。

### 2.6 runner 与 PTY 会话是同一套

`orchestrator_service.rs:7424-7495` 的 `start_runner_coordinator_with_terminal` 里，runner 就是通过 `terminal.create_shell_session()` 起的**普通 PTY 会话**（:7457），只是额外在 `runner_service` 记了一笔账（:7469-7478）。

**含义**：runner 进程同样受 Job Object 保护、同样出现在 `get_resource_tree` 的 sessions 里、也同样**不受任何资源限制**。阶段一在 `job.rs` / `mod.rs` 的改动对 runner 自动生效，不需要单独处理。

### 2.7 实测验证（2026-08-01，本机 32 核 / 93.6 GB）

以上结论**不是读代码推断，是运行时实测**。

**进程链**（一个 Claude 会话）：

```
cc-panes.exe → cc-panes-daemon.exe → claude.exe → bash.exe ×3 → powershell.exe
   47368           63364              96868 ↑PTY根            （4 层之后）
```

注意 **CLI 进程的父进程直接是 daemon**，中间没有 shell——PTY 根进程就是 `claude.exe` 本身。

**Job 继承与实际生效的限制**（在距 PTY 根 4 层的孙进程里查 `QueryInformationJobObject`）：

```
LimitFlags=0x00002000   ← 仅 KILL_ON_JOB_CLOSE
ActiveProc=0  ProcMem=0  JobMem=0
```

两点被同时证实：**Job 归属沿进程树无限继承**（CLI 工具起的 `rg`/`cargo`/`node` 全在里面，阶段一的限制自动覆盖），且**除 KILL_ON_JOB_CLOSE 外确实什么都没设**。

> ⚠️ **踩坑记录：别用 MSIX 进程验证 Job 限制**。首次探测拿到 `LimitFlags=0x800`(`BREAKAWAY_OK`)，因为用的是 MSIX 打包的 pwsh——MSIX 容器自带一层 job，嵌套 job 下 `QueryInformationJobObject(NULL)` 只报**最内层**，把真实的 PTY 会话 job 完全遮住了。必须用非 MSIX 的进程链（如 System32 的 `powershell.exe`）去探。

**并发规模现状**：

```
17 × claude.exe  +  4 × wsl.exe  +  1 × pwsh   = 22 个会话根
22 × OpenConsole.exe                            = 每会话一个 ConPTY 宿主
整机 57.1 / 93.6 GB 已用，32 逻辑核，无任何并发闸门
```

**不在会话树内的进程**（`cc-panes.exe` 的直接子进程）：`msedgewebview2.exe`、`cc-panes-web.exe`、`cc-panes-daemon.exe` 自身。shared MCP 服务器也在这一层。这些**不受任何会话级限制**。

**架构含义**：Job 是在 **daemon 进程**里创建的，所以 `KILL_ON_JOB_CLOSE` 绑的是 daemon 生命周期而非 app。这与「daemon 是跨 app 重启存活的锚点」自洽——app 重启不会误杀会话树。

### 2.8 WSL 会话在资源视图里是隐形的（严重）

同一次实测：

| | Windows 侧读数 | 真实负载 |
|---|---|---|
| 4 个 `wsl.exe` 会话根 | 各 **7.9 MB / 0.1s CPU** | — |
| `vmmemWSL` | 未归属任何会话 | **10.7 GB** |

`wsl.exe` 只是个瘦客户端，真正干活的进程活在 WSL2 VM 里。所以：

- **`get_resource_tree` / 状态栏 popover 对 WSL 会话的读数接近于零**——它们看起来永远"很闲"
- 用户看到的是"所有会话都不占资源，但整机被吃满 12 GB"
- **Job Object 对 WSL 会话完全无效**：那些进程根本不是 Windows 进程

这是一个比"限制缺失"更隐蔽的问题——**监控在说谎**，而且症状与"WSL 会话确实空闲"完全同形。

### 2.9 会话进程归属会随迭代顺序漂移（**待修**，已登记未排期）

> 发现于 2026-08-02 加进程明细列表时。**不在 0.11.8 批次内**——属于另一条链路，混进当前批次会让 review 和回滚变难。

`system_stats_service.rs::build_resource_tree_from_snapshot` 用一个"先到先得"的集合给进程去重：

```rust
let mut assigned = HashSet::new();
sessions.iter().map(|session| {
    let owned = index.descendants_including(session.root_pid);
    let process_ids = owned.into_iter()
        .filter(|pid| assigned.insert(*pid))   // ← 谁先迭代到谁拿走
```

去重本身是必要的（否则嵌套会话的进程被重复计入，整机加总超过 100%）。问题是**用什么规则决定归谁**。

**根因一 · 输入顺序不确定。** `sessions` 一路回溯是：

```
build_resource_tree_from_snapshot(&roots)
  ← system_stats_commands.rs:46  session_roots(...get_all_status()?)
  ← terminal_service.rs:2700     sessions.iter().map(...)          ← 直接迭代 HashMap
  ← terminal_service.rs:803      sessions: Arc<Mutex<HashMap<String, TerminalSession>>>
```

`HashMap` 的迭代顺序是未指定的。注意**不是每次刷新都会变**——同一个 map 实例在不发生 rehash 时顺序是稳的，所以平时看不出来；顺序会在**插入/删除会话时**（开标签、关标签、会话退出）改变，跨进程重启也不保证一致。这正是它难被发现的原因：偶发、且与"进程真的挪了窝"同形。

注意 `session_usage.sort_by(session_id)` 排的是**结果**，去重在那之前就按输入顺序做完了——排序修不了这个。

**根因二（更本质）· "先到先得"本身就是错的规则。** 就算把顺序完全定死，它依然给不出正确答案：若会话 B 的根进程是会话 A 根进程的后代，`descendants_including(A)` 会把 B 的整棵子树一并吞掉，B 报出接近 0。谁赢**只取决于迭代顺序，与进程树的实际形状无关**。

**复现条件**：需要「一个会话根是另一个会话根的后代」。我**没有确认**本仓库当前存在这种拓扑——runner 虽然是普通 PTY 会话（见 2.6），但 worker 的 PTY 由 app 直接 spawn，是 app 的子进程而非派发者会话的子进程；Windows 上父进程死亡也不会把子进程重挂到 init。所以这条目前更像**潜在缺陷**而非已复现的线上问题。**但根因一（顺序不定）是无条件成立的**，只要出现嵌套就会以随机的一侧表现出来。

**为什么现在值得记**：加了进程明细列表之后，这个漂移从"两个汇总数字微妙地不对"变成了"同一个 `rustc.exe` 这次挂在会话 A、下次挂在会话 B"——**可见性大幅提高，用户会先看到它**。

**建议修法**（按推荐度）：

1. **按最近祖先归属**（推荐）。对每个 pid 向上走祖先链，遇到的**第一个**会话根即所有者——语义正确、与迭代顺序无关，天然处理嵌套。`ProcessIndex::ancestors_including` 已经有了，改动集中在这一个函数。同 `root_pid` 注册了多个会话时按 `session_id` 定序兜底。
2. **仅稳定化顺序**（下策）。去重前按 `session_id` 排序 `sessions`。只解决根因一，赢家依然是"字典序最小的那个"这种无意义规则；但改动一行，可作为临时止血。

**实施注意**：`orphan_roots` / `kill_orphans_from_snapshot` 共用同一套 `analyze_process_ownership`，改归属规则时必须确认孤儿判定与终止守卫的语义不被牵动——**杀错进程的代价远高于统计偏差**。需要一个「B 的根是 A 的后代」的双会话测试，断言两种输入顺序下结果完全一致。

---

## 3. 附带调查（B 类：输出洪水）

虽然本文主题是 A，但探索中把 B 的链路也摸清了，一并记录，避免下次重查。

```
PTY reader (4KB read)
  → ReplayBuffer(8MB) + OutputBuffer(20k行/20MB)
  → batch_tx (std mpsc, 无界)
  → 合批线程 (16KB 或 16ms)
  → EventEmitter.emit("terminal-output")
      ├─ Tauri 直连: emit_to_webview
      └─ daemon: WsEmitter.publish → tokio unbounded → WS → 桥 → emit_to_webview
  → terminalService dispatchOutput (无订阅者时 pendingBuffers 上限 1000)
  → TerminalView → createTerminalWriteFlowControl (仅 Windows) → term.write()
```

| 机制 | 后端 | 前端 |
|---|---|---|
| chunk 大小限制 | ✅ 4KB read / 16KB batch（`terminal_service.rs:2145`） | ❌ |
| 时间窗合批 | ✅ 16ms（`terminal_service.rs:2146`，注释写明防 WKWebView 主线程死锁） | ❌ 无 rAF 合批 |
| 背压（反压上游） | ✅ WS 广播改有界 256 + desync 契约（见 §3.1）；`terminal_service.rs:2141` 的 std mpsc 仍无界（Tauri 直连路径，待观察） | ✅ `terminalWriteFlowControl.ts`（128KB/水位 10↔5）**全平台启用** |
| 丢弃策略 | ✅ ring buffer FIFO + spinner 行过滤 + 连续空行压缩（`terminal_service.rs:592-617`）；WS 溢出整段跳过 + desync 重放 | ⚠️ 仅无订阅者时丢最旧一半（`terminalService.ts:79`） |
| ring buffer 上限 | ✅ 20k行/20MB/8MB replay（`terminal_service.rs:849-854`） | ✅ scrollback 默认 20k，钳 200–100000，运行时热更 |
| **后台 tab 暂停** | — | ✅ 512KB 隐藏积压 + 边沿 flush（0.11.8）；溢出时可见性回归自动 snapshot 重放（0.11.9 后续，复用 desync 链路），截断提示仅剩退出兜底 |
| **后台降档/休眠** | — | ✅ 5min 挂 WebGL / 30min 休眠（§3.1） |
| renderer | — | webgl/dom；**Windows 默认 dom**（`terminalRenderer.ts:171` `windows-cjk-guard`） |

**原"三个最大风险点"均已修复**：

1. **后台标签页不暂停** — 0.11.8 修复（commit 20d0603 + 16377e6）：`terminalHiddenWriteBuffer.ts` 512KB 积压、hidden→visible 边沿 flush、溢出截断提示。
2. **daemon 侧无界广播** — 已改有界 256 + desync 契约（`cc-panes-daemon/src/ws_emitter.rs`、`cc-panes-web/src/ws_emitter.rs` 同形）。
3. **flow control 只在 Windows 开** — 已全平台启用（`TerminalView.tsx` 调用点删掉 `enabled: IS_WINDOWS`）。

### 3.1 后台休眠与 desync 契约（低配机防护收尾批次）

实测背景：v0.11.7 下 14 个挂载标签 + 3 天运行，renderer 3.8GB / 0.7 核、CC-Panes 独家掉帧（整机 CPU 27%、dwm 0%、GPU 正常——B 类判据实锤案例）。主因是**每个挂载标签的 xterm circular buffer 常驻**（scrollback 20000 行 × cols × cell 对象 ≈ 50MB+/实例）。

用户约束：scrollback 默认 20000 不动、不许裁历史。参照 VS Code（SerializeAddon 序列化持久化）与 orca（agent hibernation），落地**后台分层降档**：

```
隐藏 T+5min  ：挂起 WebGL（terminalRendererController.suspendWebgl，Windows 恒 DOM 为 no-op，
               但释放 ~16 上限的 WebGL context 槽位）
隐藏 T+30min ：休眠——SerializeAddon 全量序列化（含全部 scrollback 与颜色，~1-4MB 字符串）
               → dispose xterm 实例 → 轻量订阅继续收集输出（上限 4MB，溢出作废）
切回可见     ：epoch 自增重跑 init effect 全量重建 → 回放休眠字符串（历史零丢失）；
               溢出时改走后端 8MB replay snapshot
```

关键文件：`terminalBackgroundLifecycle.ts`（定时器状态机）、`terminalHibernation.ts`（休眠容器）、`terminalResync.ts`（snapshot 重同步，与 desync 共享）、`TerminalView.tsx` 的 `instanceEpoch`。

**desync 契约**（daemon/web WS 广播）：会话镜像通道 `mpsc::channel(256)`（≈4MB/慢客户端上限）；溢出后**绝不掐 VT 流中段**——整段跳过 + 置 desynced，排空后插入 `{"type":"desync"}`；客户端（桥 `DaemonStreamMessage::Desync` → `terminal-desync` 事件 → `terminalResync.ts`）reset + snapshot 重放。exit/killed 是终止性消息，队列满时走 control 兜底（notifier/sessionExited）不丢。旧客户端不认识 desync 会静默忽略（`Unknown` 兜底），行为不劣于改造前。

> 仓库里"有界通道 + shed"的既有范式（文件监听：有界 30k channel + shed，`CHANGELOG.md:147`）至此也覆盖了 PTY 输出的 WS 段。仍未覆盖：`terminal_service.rs:2141` 的进程内 std mpsc（Tauri 直连模式，合批线程消费快，暂无实测积压证据）。

---

## 4. 根因

**CC-Panes 把子进程的资源约束完全交给了操作系统的默认调度。**

三件事叠加：

1. **无约束** — 每个 PTY 子进程都以 `NORMAL_PRIORITY_CLASS` 起、无内存上限、无 CPU 配额，跟 CC-Panes 自己的 UI 线程平起平坐抢资源
2. **无闸门** — 没有任何机制阻止十个窗格同时启动重负载
3. **归因数据存在但不主动呈现** — 系统知道是谁在吃资源，却要求用户在最卡的时候主动去点 popover 才肯说

值得强调的是第 3 点：**这不是数据缺失问题，是产品形态问题**。`ResourceTree` 已经能回答"谁在吃 CPU"，只是没人在正确的时机问它。

---

## 5. 为什么 Job Object 是正确的切入点

- 每个 PTY 会话**已经有一个专属 Job**（`ProcessJob::create_for`，每次 spawn 创建一个），不需要新建对象或改变生命周期
- `OpenProcess` 已经带了 `PROCESS_SET_QUOTA`（`job.rs:52`）——**加 limit 不需要提权、不需要改权限申请**
- 限制作用于**整棵进程树**，正好匹配"pwsh → cargo → rustc ×N"这种真实负载形状；按单 PID 限根本限不住
- 改动范围极小：同一个 `SetInformationJobObject` 调用里多设几个字段，再加一次 `JobObjectCpuRateControlInformation` 调用
- Job 创建失败已有 warn-not-fatal 的降级路径（`pty/mod.rs:170-181`），加限制不改变失败语义

**风险**：Job Object 是 Windows-only（`job.rs:11` 的 `#![cfg(windows)]`）。Linux/macOS 侧无对应实现，见第 7 节。

---

## 6. 分期方案

### 阶段一：防洪与限流

| 项 | 落点 | 说明 |
|----|------|------|
| **默认降优先级** | `pty/mod.rs:170-181` assign 之后对 `root_pid` 设 `BELOW_NORMAL_PRIORITY_CLASS` | **收益/风险比最高，优先做**。让 UI 永远抢得过编译，且不影响吞吐（空闲核照样用满） |
| Job 内存/进程数上限 | `pty/job.rs:40-47` 加 `JOB_OBJECT_LIMIT_JOB_MEMORY` + `ACTIVE_PROCESS` | 上限**可配置且默认宽松**，目标是防失控不是设天花板 |
| Job CPU 配额 | 新增 `SetInformationJobObject(JobObjectCpuRateControlInformation)` | 用 `WEIGHT_BASED` **软配额**，不要 `HARD_CAP`——硬顶会把正常编译拖成龟速 |
| **WSL 会话配额** | `wsl_codex.rs:748-755` 包 `systemd-run --user --scope` | 见 7.2，**已实测可用**。Job Object 对 WSL 无效，不做这条则 WSL 会话完全裸奔 |
| **WSL 配置面板** | Settings → System 新增 WSL 段 + `EnvironmentPreflightCard` 提示 | 见 7.4。读 `.wslconfig` 给推荐值，覆盖"用户自己的 WSL 配置有洞"这一层 |
| 通用启动闸门 | 上提 `terminalRestoreQueue.ts` 的队列，覆盖 `launch_task` 与手动开标签 | 现在只管崩溃恢复 |
| （B 类，可同期）后台 tab 输出暂停 | `TerminalView.tsx:774-838` output 回调消费 `isVisibleRef` | 需保证切回时能从 ring buffer 补齐，不能丢字 |

**验收标准**：
- 单窗格 `cargo build --workspace` 期间，CC-Panes UI 切标签/拖分屏无可感延迟
- 三窗格并发编译，整机仍可正常操作浏览器
- Job 限制生效验证：`SetInformationJobObject` 返回值断言 + 一个超限进程被拒的集成测试
- 降优先级不得让单次编译耗时上升超过 15%（空闲机器上对照测量）
- WSL 会话包 scope 后，`cat /sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)/cpu.weight` 返回设定值而非 `100`
- **WSL 配置面板打开时 `vmmemWSL` 不被拉起**（VM 原本未运行的情况下，打开设置页后仍不存在该进程）——这是零唤醒要求的直接验收项
- 写入 `.wslconfig` 后重新读取，用户原有注释与未涉及的键**逐字保持不变**

### 阶段二：资源可见性与管控

| 项 | 落点 | 说明 |
|----|------|------|
| per-session 采集**边沿触发**常驻化 | `SystemResourceSegment.tsx` / `system_stats_commands.rs` | 整机 CPU 越阈值才开 per-session 采样，回落即停 |
| 标签页资源徽标 | 复用 `SystemResourcePopover.tsx:132-160` 的数据源 | 超阈值时肇事标签打琥珀徽标（遵循 `docs/46-frontend-styleguide.md` 琥珀约定） |
| 低于杀进程的干预档位 | 复用 `root_pid` + 进程树能力 | 单会话"临时降优先级 / 限核"入口 |

> ⚠️ **边沿触发是硬要求**，不是优化。`docs/41` 记录过：0.10.20 给 129 个注册项目各起一个 2 秒轮询线程，28.6 核持续忙碌。**用一个监控资源的功能把资源吃掉，是本仓库犯过的错。** 采集必须跟随信号惰性起停。

**验收标准**：
- 空闲时（整机 CPU 低于阈值）per-session 采集**完全不运行**，可用采样计数断言
- 制造一个吃 CPU 的窗格，徽标在 10s 内出现在**正确的**标签上
- **WSL 会话的读数不再是 7.9 MB 的假值**（第 2.8 节），而是来自 cgroup 的真实用量
- 降优先级操作后，`get_resource_tree` 中该会话 CPU 占比下降

---

## 7. WSL 管理设计

WSL 会话不是边角情况：本机 22 个会话里有 4 个是 WSL，占了 **10.7 GB**（第 2.8 节）。Job Object 对它们**完全无效**，需要一套独立机制。

### 7.1 实测：能力探底（2026-08-01，Ubuntu 24.04）

```
systemd            : running
cgroup             : cgroup2fs（统一层级）
root controllers   : cpuset cpu io memory hugetlb pids rdma
user@1000 委派     : cpu memory pids          ← 关键，无需 root
```

**CC-Panes 会话的实际落点是 `/init.scope`**（不是 `user.slice`）：

```
裸跑（现状）                    memory.max=max   cpu.weight=100   cpu.max=max
包进 systemd-run --user --scope  memory.max=2G    cpu.weight=20    cpu.max=400000 100000
```

**`systemd-run --user --scope -p CPUWeight=20 -p MemoryMax=2G -p CPUQuota=400%` 三项全部生效**——无需 root、无需 `wsl --shutdown`、每会话独立、可动态调整。这是 WSL 侧的正解。

### 7.2 三层设计

| 层 | 机制 | 粒度 | 性质 |
|----|------|------|------|
| **L1 VM 天花板** | `.wslconfig` 的 `processors` / `memory` | 全 VM | 用户配置建议，**非代码改动** |
| **L2 会话级配额** | `systemd-run --user --scope` + cgroup v2 | 单会话 | **主方案**，代码改动 |
| **L3 降级兜底** | `nice -n N` 前缀 | 单会话 | systemd 不可用时 |

**L1 现状问题**：本机 `.wslconfig` 有 `memory=80GB` 但 **`processors` 未设 = 全部 32 核**。建议设 `processors=24` 给 Windows 留出余量。注意 L1 是**全局**的、影响用户所有 WSL 用途（不只 CC-Panes）、且需 `wsl --shutdown` 生效——所以它只能是兜底，不能替代 L2。

**L2 注入点**：`cc-panes-core/src/services/terminal_service/wsl_codex.rs:748-755`

```rust
let args = vec!["-d", distro, "--", "bash", WSL_BASH_LOGIN_FLAG, script_path];
//                              ↓ 改为
let args = vec!["-d", distro, "--",
                "systemd-run", "--user", "--scope", "-q",
                "-p", "CPUWeight=20", "-p", "MemoryHigh=8G", "--",
                "bash", WSL_BASH_LOGIN_FLAG, script_path];
```

包住登录 shell 后，会话内起的一切（`rg`、`cargo`、子 agent）都继承该 cgroup。

### 7.3 设计要点（易错处）

1. **用 `MemoryHigh` 而非 `MemoryMax`**。`MemoryMax` 是硬限，超了直接 OOM kill——用户看到的是**莫名其妙的 build 失败**，且不会联想到是 CC-Panes 设的限制。`MemoryHigh` 是软限，只触发激进回收+throttle，不杀进程。同理 `CPUWeight`（竞争时降权、空闲时仍可用满）优于 `CPUQuota`（硬顶，会把正常编译拖成龟速）。
2. **必须探测 + 缓存 + 降级可见**。systemd 可能被 `wsl.conf` 关掉、非 systemd 发行版也存在。探测结果要缓存（复用 `wsl_codex.rs:18` 已有的 WSL 能力探测缓存模式，避免每次 `create_session` 冷跑）。降级到 L3 时**必须对用户可见**——这是本仓库的既有教训（docs/45：Codex resume 捕获链静默失效）。
3. **多 distro 各自独立**。cgroup 只在其所属 VM 内有效，配额是 per-distro 的。
4. **抽象要统一，实现可分叉**。用户不该被迫理解两套机制。建议引入统一的 `SessionResourcePolicy { priority, memory_soft_limit }`，Windows 走 Job Object + `SetPriorityClass`，WSL 走 systemd scope，SSH runtime 走 `nice`。否则 UI 上会长出两套互不相干的开关。
5. **可观测性必须同期补**，否则限制生效与否无法验证。方案：会话为 WSL 时，从 cgroup 读 `memory.current` / `cpu.stat` 回传，替换掉当前那个恒为 7.9 MB 的 `wsl.exe` 读数。这也顺带修掉第 2.8 节的"监控说谎"问题。

### 7.4 WSL 配置面板（读取 + 推荐 + 引导应用）

L1 那层不能只写在文档里指望用户自己去改 `.wslconfig`——**绝大多数用户根本不知道这个文件存在**。需要在应用内给出读取入口与推荐值。

#### 落点

| 位置 | 职责 |
|------|------|
| **Settings → System 新增 "WSL" 段** | 正式的家：三态展示 + 推荐 + 应用 |
| **`EnvironmentPreflightCard`** | 发现性：`processors` 未设时出一条琥珀提示，点进去跳转 WSL 段 |

数据模型扩展现有的 `EnvironmentInfoRaw.wsl`（`web/types/settings.ts:201`，现为 `{ installed, version, applicable }`）。

#### 配置全景：约 30 个键，两个文件，两套权限

WSL 的配置面比"改几个资源参数"大得多：

| 文件 | 作用域 | 写入权限 | 主要 section |
|------|--------|----------|--------------|
| `%USERPROFILE%\.wslconfig` | **全局**（所有发行版） | 普通用户 | `[wsl2]`、`[experimental]` |
| `/etc/wsl.conf` | **单个发行版**（在 distro 内部） | **需 root/sudo** | `[boot]`、`[interop]`、`[network]`、`[automount]`、`[user]` |

**设计原则：CC-Panes 只对「影响 CC-Panes 自身行为」的键给建议，其余只读或不显示。** 否则就是在做一个更难用的文本编辑器——既是范围蔓延，也没有价值：用户要通改配置，记事本比我们强。

按"CC-Panes 为什么关心"分四类：

| 类 | 键 | 利害关系 | 面板行为 |
|----|----|----------|----------|
| **A 资源争抢** | `processors`、`memory`、`swap`、`autoMemoryReclaim`、`vmIdleTimeout` | 本文主线 | 给建议 + **可写** |
| **B 功能前置条件** | `[boot] systemd`、`[interop] enabled`、`[interop] appendWindowsPath` | 决定 CC-Panes 的能力**能否工作** | 给诊断 + **只读**（需 root） |
| **C 网络 / 端口** | `networkingMode`、`hostAddressLoopback`、`firewall`、`dnsTunneling`、`autoProxy`、`localhostForwarding` | 与端口冲突检测、runner 端口、代理设置交互 | 只读 + 解释影响 |
| **D 无关** | `kernel*`、`debugConsole`、`safeMode`、`nestedVirtualization`、`defaultVhdSize`、`guiApplications`、`[automount]`、`[user]` | 无 | 折叠区只读，或不显示 |

**B 类是配置面板真正的价值所在**，因为它把面板从"信息展示"变成了"能力前置检查"：

- **`[boot] systemd`** —— 7.2 的 cgroup 方案**完全依赖它**。为 `false` 时 `systemd-run` 不可用，WSL 会话资源限制只能降级到 `nice`。面板应直接显示「systemd 未启用 → WSL 会话资源限制不可用」并给出修复命令。
- **`[interop] appendWindowsPath`** —— 默认 `true`，是 CLAUDE.md 里那条「WSL 里 `claude` 静默解析到 `claude.exe`，报错伪装成我们的路径 bug」的根源。
- **`[interop] enabled`** —— 关掉则 WSL↔Windows 互操作断裂，CC-Panes 的 MCP proxy 链路受影响。

> 实测本机 `[interop] appendWindowsPath` **未显式设置**（即默认 `true`），但 login shell 的**实际 PATH 里 `/mnt/c` 条目数为 0**。配置默认值与实际生效状态可以不一致（profile 脚本会重写 PATH）——这再次说明面板必须展示 **effective 值**，光读配置文件会得出错误结论。

#### 渐进披露：默认只显示"有问题的"

约 30 个键全列出来等于没列。默认视图只显示**有建议或有风险**的项（正常机器通常 0–3 条），其余进折叠区；全部正常时显示一句「WSL 配置无明显问题」即可。

#### WSL1 / 多发行版

- **WSL1 发行版**无 VM、无 cgroup，`.wslconfig` 完全不适用 → 整体标记「资源管控不适用」，不要给任何建议
- `/etc/wsl.conf` 是 **per-distro** 的，N 个发行版要读 N 份；`.wslconfig` 全局一份
- 实测本机同时运行 `Ubuntu` 与 `docker-desktop` 两个发行版（WSL 2.7.11.0）

#### 读取：必须零唤醒 VM

> ⚠️ 这是本功能最容易做错的地方。`usage_stats_service.rs:131` 记着 issue #37：**访问 `\\wsl$` 或调用 `wsl.exe` 会拉起/保活 Vmmem VM**。一个"读配置"的功能如果把用户的 WSL 唤醒了，它自己就变成了新的资源问题。

规则：

- 直接读 `%USERPROFILE%\.wslconfig` **文件**，绝不经 `wsl.exe`
- 需要判断 VM 是否在跑时，复用 `wsl_discovery_service.rs:92` 的 `is_wsl_vm_running()`（只查 vmmemWSL 进程，零副作用）
- 任何 `wsl.exe --list --running` 类调用必须先过 `is_wsl_vm_running()` 门控（沿用 `usage_stats_service.rs:300` 的既有模式）

**`/etc/wsl.conf` 与零唤醒的冲突**：它在 distro 内部，读它要么走 `\\wsl$`、要么 `wsl.exe -d X cat`——**两条路都会唤醒 VM**，与上述规则直接冲突。

解法是**搭 launch 的便车**：CC-Panes 启动 WSL 会话时本来就在跑脚本，此时顺带读一次 `/etc/wsl.conf` 并缓存。仓库里已有完全对应的先例——`wsl_codex.rs:183` 的 `probe_wsl_locale_summary` 就是在 launch 时（`:738`）搭车探测 locale 的；能力缓存则复用 `wsl_codex.rs:18` 那套（其注释写明目的正是"避免每次 create_session 冷跑 wsl.exe"）。

规则：**永不为了读配置而唤醒 VM**。VM 未运行且无缓存时，B 类项显示「未知（WSL 未运行）」，而不是去把它拉起来。

#### 解析：INI 不是 TOML

`.wslconfig` 是 INI 格式。**不要用 `toml` crate**——`memory=80GB` 这种裸值会直接解析失败。workspace 当前无 ini 依赖。建议手写解析：格式极简，且手写才能在写回时**保留用户的注释与键顺序**（实测用户配置里带着中文注释说明为何调高 memory，抹掉是不可接受的）。

#### 展示：三态，必须区分"未设置"与"无风险"

| 列 | 含义 |
|----|------|
| 当前值 | `.wslconfig` 里字面写的（可能为"未设置"） |
| **实际生效** | 未设置时填入 WSL 的默认行为 |
| 推荐值 | 见下表，附理由 |

> **"文件不存在" ≠ "没问题"。** 大多数用户没建过 `.wslconfig`，此时是全部取默认：`memory` ≈ 50% 物理内存、**`processors` = 全部逻辑核**。UI 必须显示"未设置 → 实际生效 32 核"，只显示空白会让用户以为一切正常。实测本机就是这个情况。

#### 推荐规则：只对隐性风险告警，不干涉显式选择

| 类 | 项 | 判定 | 动作 |
|----|----|------|------|
| A | `processors` | 未设 / = 全部核 | ⚠️ 建议 `max(2, 核数 - 8)`（32 核 → 24） |
| A | `memory` | 未设 | ℹ️ 说明默认约 50%，通常不必改 |
| A | `memory` | **已显式设置** | ✅ **不给建议**，只展示 |
| A | `autoMemoryReclaim` | 未设 | ℹ️ 建议 `dropcache` |
| **B** | `[boot] systemd` | `false` / 未设且发行版无 systemd | ⚠️ **WSL 会话资源限制不可用**（7.2 失效），给出修复命令，**不代写**（需 root） |
| **B** | `[interop] appendWindowsPath` | `true`（默认） | ℹ️ 提示 CLI 可能解析到 Windows 版（CLAUDE.md 既有 gotcha），仅在检测到实际命中时才升级为警告 |
| C | `networkingMode` 等 | 任意 | 只读展示 + 一句影响说明，**不给建议** |
| D | 其余约 15 个键 | 任意 | 折叠区只读 |

设计原则：**只对"未设置导致的隐性风险"告警，不对用户的显式选择指手画脚。**

理由有二。其一，实测用户配置里 `memory=80GB` 带着注释"ML 训练需要大内存"——这是刻意的，工具若因"高于默认"就劝其调低，等于跟用户吵架，用两次就再也不会被打开。其二，从资源争抢角度，`memory` 是**天花板不是预留**，配合 `autoMemoryReclaim` 危害有限；**CPU 饱和才是 UI 卡顿的直接原因**，内存压力是更慢更间接的路径。故推荐优先级 `processors` > `memory`。

#### 应用：写入 + 引导重启

`.wslconfig` 需 `wsl --shutdown` 才生效。**`wsl --shutdown` 会终止所有 WSL 发行版**——含 CC-Panes 自己的 WSL 会话，以及用户在 CC-Panes 之外的全部 WSL 工作。

分两步，不可合并：

**步骤 1 · 写入**（低风险）
- 保留原有注释与键顺序，只改动目标键
- 写入前备份为 `.wslconfig.bak`
- 写完即告知"下次 WSL 重启后生效"，**此步到此为止，不隐含重启**

**步骤 2 · 引导重启**（高风险，独立触发 + 二次确认）

确认对话框必须**先算出并列出完整影响面**，再让用户点：

1. CC-Panes 自己的 WSL 会话数与标签名（从会话账本按 `runtimeKind == "wsl"` 过滤）
2. **CC-Panes 之外的运行中发行版**（`wsl.exe --list --running`，需先过 `is_wsl_vm_running()` 门控）
3. 明示"这些会话中未保存的工作会丢失"

> ⚠️ **第 2 条不是形式主义**。实测本机除 `Ubuntu` 外还跑着 **`docker-desktop`**——`wsl --shutdown` 会把它一起关掉，等于**拆掉用户整个 Docker 环境**（所有容器停止，Docker Desktop 需重新启动）。这个杀伤面远超"4 个 CC-Panes 会话"，而用户在点按钮时**完全想不到**。对 `docker-desktop`、`docker-desktop-data` 这类基础设施发行版必须**单独高亮标注**，不能混在普通列表里一笔带过。

**硬性要求**：

- 绝不自动重启，绝不把重启做成写入的副作用
- 影响面为空（无运行中 WSL）时才可提供"一键重启"；否则默认动作是**取消**，重启为次要按钮
- 检测到基础设施发行版（docker-desktop 等）时，进一步降级为「只显示手动命令，不提供按钮」
- 重启后 CC-Panes 侧的 WSL 会话会走正常的 `terminal-exit` 路径，不需要特殊处理；但应提示用户可用会话恢复（docs/66）找回上下文

### 7.5 其他平台

| 平台 | 原语 | 建议 |
|------|------|------|
| Windows | Job Object（已有对象，加 limit 即可）+ `SetPriorityClass` | 阶段一主战场 |
| WSL2 | systemd scope + cgroup v2（**已验证可用**） | 阶段一同期，见 7.2 |
| Linux 原生 | 同 WSL2（若有 systemd） | 复用 L2 实现 |
| macOS | `setpriority` / `posix_spawn` QoS | 仅做 `nice`，成本极低 |

---

## 8. 新增 Known Gotcha 候选

> **`pty/job.rs` 的 Job Object 只做 `KILL_ON_JOB_CLOSE`，它不限任何资源**：`JOBOBJECT_EXTENDED_LIMIT_INFORMATION` 除 `LimitFlags` 外全是零值默认，看到代码里有 Job Object 就以为子进程被限住了是误读。PTY 子进程当前以 `NORMAL_PRIORITY_CLASS` 起、无内存/CPU 上限，与 CC-Panes 自己的 UI 线程平等竞争——**任一窗格的 `cargo build` 都能把整机吃满**，且没有低于"杀进程"的干预档位。`OpenProcess` 已带 `PROCESS_SET_QUOTA`，加限制不需要提权（docs/71）。

> **判断"卡"属于哪一类，先看整机 CPU**：整机高 = 子进程资源争抢（docs/71 第 2 节）；整机不高但 UI 掉帧 = xterm 输出洪水（docs/71 第 3 节，后台标签页**不暂停**输出，N 个后台会话刷屏 = N 份渲染压主线程）。两者症状同形、治法完全不同。

> **WSL 会话在资源视图里恒显示 ~8 MB / 0% CPU，那是假的**：`wsl.exe` 只是瘦客户端，真实负载在 `vmmemWSL`（实测 4 个 WSL 会话对应 10.7 GB，未归属任何会话）。所以 ①`get_resource_tree` 与状态栏 popover 对 WSL 会话的读数**接近于零且不可信**，②Job Object 对 WSL 会话**完全无效**。WSL 侧要用 `systemd-run --user --scope` + cgroup v2（实测 `user@1000` 已委派 `cpu memory pids`，无需 root）。注意 CC-Panes 起的 WSL 会话落在 `/init.scope` 而非 `user.slice`，不显式包 scope 就没有任何约束（docs/71 第 7 节）。

> **别用 MSIX 打包的进程去验证 Windows Job 限制**：MSIX 容器自带一层 job，嵌套 job 下 `QueryInformationJobObject(NULL)` 只报**最内层**，会把真实的 PTY 会话 job 完全遮住——实测用 MSIX 的 pwsh 探到 `LimitFlags=0x800`(BREAKAWAY_OK)，换 System32 的 `powershell.exe` 才看到真值 `0x2000`。

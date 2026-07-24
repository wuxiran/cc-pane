# Orca 竞品全面对比与战略判断

> 来源：2026-07-23 对 [stablyai/orca](https://github.com/stablyai/orca) 的调研（GitHub 元数据 / README / CLI specs / docs 抽读 + 本地浅克隆源码分析）。
> 本地快照：`../references/orca`（浅克隆，10387 文件）。
> 相关文档：[42-superset-competitor-analysis.md](./42-superset-competitor-analysis.md)（Superset）、[23-ccpanel-competitor-evolution.md](./23-ccpanel-competitor-evolution.md)（CCPanel）。

---

## 目录

1. [项目概况](#1-项目概况)
2. [时间线证据："抄没抄"的结论](#2-时间线证据抄没抄的结论)
3. [编排控制面逐项对照（撞得最狠的地方）](#3-编排控制面逐项对照)
4. [状态检测对比](#4-状态检测对比)
5. [架构与平台对比](#5-架构与平台对比)
6. [双方独有功能](#6-双方独有功能)
7. [源码级深挖](#7-源码级深挖)
8. [战略判断："全面落后了吗"](#8-战略判断)
9. [行动清单](#9-行动清单)

---

## 1. 项目概况

**Orca**（onOrca.dev）— Stably AI（YC 系）出品的 "ADE"（Agent Development Environment），口号 "The AI Orchestrator for 100x builders"。**MIT 许可、完全免费**，用户用自己的 CLI 订阅跑代理。

- **增长**：2026-03-17 建仓 → 2026-07 已 27.1k stars、1.9k forks、864 releases（v1.4.152）、7099 提交。四个月的 star 是 Superset 九个月的两倍多
- **发版节奏**：≈6.7 个 release/天（每合并即发的 CI 自动化），日均 55 提交——重度用 agent 写 agent 工具
- **平台**：macOS / Windows / Linux（AppImage、AUR、Homebrew）+ iOS / Android + headless VPS（`orca serve`）
- **技术栈**：Electron + Vite，TypeScript 97%，pnpm，oxlint/oxfmt；Windows 签名走 SignPath
- **市场姿态**：README 有中日韩西法葡多语言版 + 微信群，明确在攻中国市场
- **代理适配**：近 30 个（Claude Code、Codex、Grok、Cursor、Copilot、OpenCode、Amp、Cline、Goose、Qwen Code、Kimi …），"任何能在终端跑的都支持"

## 2. 时间线证据："抄没抄"的结论

| 时间 | 事件 |
|---|---|
| **2026-02-16** | CC-Panes 本地首提交 |
| **2026-03-05** | cc-pane GitHub 公开（现 490 stars） |
| **2026-03-17** | Orca Initial commit（已验证：28 文件 / 6655 行，纯脚手架起步，**非内部代码搬运**） |
| 2026-03-21 | Orca v1.0.12（从 1.0.x 起版的激进版本策略，非憋久证据） |

**功能级时间线补充（2026-07-24 考证）**：编排/leader-worker 功能上 **Orca 反而早于 CC-Panes 两到四周**——Orca `feat(orchestration): add inter-agent orchestration system`（#1188）落地于 **2026-04-28**（05-04 即补 check-wait/preamble+ask）；CC-Panes `register_plan_leader` 于 **2026-05-14~16**、`report_to_leader` 于 05-23~24 引入。时间窗近到双方都来不及看对方，架构却收敛到同一形状（派发 preamble + worker 主动上报 + 宿主转投 leader）——**双向排除抄袭，趋同演化的最干净实证**。

**结论**：CC-Panes 早一个月起步，Orca 写第一行代码时 cc-pane 已公开 12 天。但无证据表明抄袭——"worktree 并行 + hook 状态 + agent 操控宿主"当时已是赛道公共设计语汇（claude-squad、Conductor、CCPanel 均在前），且两边实现细节是独立解题（如 WSL loopback：CC-Panes 走 WSL 运行时抽象，Orca 走 WSLENV `/p` 翻译 + `/mnt/c/.../curl.exe` 降级投递）。**定性：趋同演化，CC-Panes 在先。** 这验证了 2026-02 的产品直觉正确，差距在火力（个人 442 提交 vs 团队 7099）而非方向。

## 3. 编排控制面逐项对照

Orca 走 **CLI 命令面**（agent 在终端直接跑 `orca xxx`，零协议开销、任意 agent 天然可用）；CC-Panes 走 **MCP 面**（结构化有 schema，但吃 token、依赖 MCP 支持，见 [18-mcp-startup-token-analysis.md](./18-mcp-startup-token-analysis.md)）。能力几乎一一对应：

| 能力 | Orca CLI（`src/cli/specs/`） | CC-Panes MCP |
|---|---|---|
| 列终端/面板 | terminal list / show metadata+preview | `list_panes` / `list_sessions` |
| 读子会话输出 | Read bounded terminal output | `get_session_output` |
| 注入输入 | Send input to a live terminal | `write_to_session` / `submit_to_session` |
| **等待条件** | **Wait for a terminal condition** | ❌（靠轮询 get_session_status） |
| 建会话/分屏/切页签/标题 | create / split / switch / close / title | `launch_task` + layoutId/layoutName |
| **agent 间消息** | **发 / 收 / 回 / 总览** | `report_to_leader`（单向为主） |
| 任务分派 | 任务 CRUD + Dispatch a task to a terminal | `create_todo` + dispatch-todos skill |
| 协调者 | **coordinator 循环（启/停）+ 阻塞式提问** | leader/worker 注册 + plan 协作 |
| **决策门** | **decision gates（建 / resolve / 列）** | ❌ |
| 跨 worktree 汇总 | compact orchestration summary | ❌ |
| **共享记忆** | ❌ | **memory_add/search 共享池** |
| **Resume** | ❌ | **list_launch_history → resume** |
| Spec 绑定 | ❌ | **Spec/Todo 双向绑定** |

**Orca 多出的三个高价值原语**（吸收优先级最高）：`wait`（条件等待，省轮询）、双向 agent 消息、decision gate（子任务卡在需拍板的点上显式阻塞，而不是瞎跑）。
**CC-Panes 独有**：共享记忆池、resume 链、Spec 绑定——"agent 长期协作的记忆与延续性"这一环 Orca 是空的。

**启示**：CC-Panes 的 MCP 面可补一个 CLI 薄壳（`ccpanes xxx` 命令直连本地服务），对"任意 CLI 代理"的兼容性与 token 成本都优于纯 MCP。

### 3.1 原语分类对照（2026-07-24 深化）

> 原语 = 系统提供的最小操作积木（非面向用户的功能）。判据：多个上层功能在重复手搓的东西就该沉淀为原语。

**① 会话/终端控制——基本打平，各有细节优势**

| 能力 | CC-Panes | Orca |
|---|---|---|
| 起会话 | `launch_task`（含 resume 分支） | `worktree create --agent --prompt`（建 worktree+起 agent 一步） |
| 注入输入 | `write_to_session`（控制键）+ `submit_to_session`（CR 时序，但延迟靠长度启发式猜） | bracketed paste + 就绪信号（多行安全，见 §7 prompt 投递） |
| 读输出 | `get_session_output`（**无边界语义**） | terminal read（有界：2000 行/256KB 滚动 + cursor 分页 + truncated 语义）✅值得抄 |
| 杀会话 | `kill_session`（taskkill /T 树杀）✅更强 | stop（Windows 无树杀） |

**② 同步原语——Orca 有、CC-Panes 无，最大缺口**

| Orca | CC-Panes 现状 |
|---|---|
| `wait --for exit\|tui-idle`（事件驱动 waiter + blockedReason） | ❌ 各 skill 重复手搓"轮询 get_session_status + 软超时" |
| `ask`（阻塞式向协调者提问，600s 超时，进程内 waiter 长轮询） | ❌ worker 无标准"卡住等拍板"通道 |
| `gate create/resolve`（决策门，任务 blocked↔ready，人工强制 resolve） | ❌ 靠 plan 文档约定 + 人盯 |

**③ 通信原语——Orca 完整邮箱 vs CC-Panes 单向上报**

Orca：send / check（`--wait` 阻塞 / `--peek` 不消费）/ reply / inbox，thread + 优先级 + 群发（`@all`/`@worktree:<id>`），SQLite 持久化，delivered/read 正交状态位，idle 推送注入 PTY。
CC-Panes：`report_to_leader` 单向上行 + busy 排队补投；**leader→worker 下行靠 submit_to_session 裸注入**，无横向通信、无 thread/群发。

**④ 任务原语——Orca 有 DAG，CC-Panes todo 是平的**

Orca：task `deps` 依赖数组 + `worker_done` 对账后 `promoteReadyTasks` 自动推进 + dispatch 熔断（3 次失败 circuit_broken）+ 跨 worktree summary。
CC-Panes：todo CRUD + task binding 有，但无依赖、无自动推进、无熔断；分派是 skill（功能层）非原语。

**⑤ CC-Panes 独有原语（Orca 全部为零）**

记忆（memory_add/search/update）、续会话（list_launch_history + resume）、Runner（start_runner/profiles/端口冲突）、工作空间管理（create_workspace/scan_directory）、Spec 绑定、ccchan 通知。**这是"编排的上下文层"——纯信箱模型撑不起长周期协作，是 CC-Panes 差异化的根。**

**两个哲学级差异**：①身份模型——CC-Panes 注册制（register_plan_leader/worker 显式建立带 plan 上下文的协作关系，表达力强）vs Orca 匿名信箱制（handle 随起随用 + pane_key 事后对账，松耦合）；②协调者——Orca 把 coordinator 做成原语（确定性调度循环，无 LLM，管派发/心跳/熔断等机械事务）vs CC-Panes 的 leader 是 AI 约定角色（管审查/改计划等判断事务）。两者互补而非互斥。

## 4. 状态检测对比

- Orca：**hook HTTP 单通道**（`src/main/agent-hooks/server.ts` 绑 127.0.0.1 + `X-Orca-Agent-Hook-Token` 鉴权），正在把 sidebar 迁到 **hooks-only**、弃用标题文本推断 fallback（PR 7447 相关）——等于独立走到了 CC-Panes"只信 OSC/hook 不信文本"铁律的位置，反向验证了该铁律
- CC-Panes：OSC in-band + hook HTTP **双通道** + 跨通道去重状态机（`session_state_machine.rs`），语义更强
- Orca 的 WSL hook 投递工程值得抄（`docs/agent-status-over-wsl.md`，STA-1515，已台架验证）：WSLENV `/p` 路径翻译让 WSL 进程经 `/mnt/c` 读 Windows 侧扩展；loopback 连不通时降级用 `/mnt/c/Windows/System32/curl.exe`（Windows 进程的 127.0.0.1 才是宿主 loopback）fire-and-forget 投递，`--connect-timeout 3 --max-time 10`，负载下容忍 0.5s 丢报。**若 CC-Panes hook 通道在 WSL2 NAT 下丢报，这是现成解法**
- SSH 场景他们有专门 relay（`src/relay/agent-hook-server.ts`、`src/shared/agent-hook-relay.ts`）

## 5. 架构与平台对比

| 维度 | Orca | CC-Panes |
|---|---|---|
| 框架 | Electron + Vite，TS 97% | Tauri 2，Rust 后端 + 系统 WebView |
| 资源占用 | Electron 基线高（自有 renderer 内存 profile 文档在压） | 天然轻，**10 实例场景优势放大（结构性，不可被优化追平）** |
| 终端渲染 | WebGL | xterm.js，Windows 落 DOM（WebGL CJK 花屏——他们未必踩过，中文用户多了会爆） |
| 平台 | 全平台 + 移动双端 + VPS | Windows 主场 + Web 远程 + Flutter 移动端 |
| 数据 | 本地为主，MIT 免费无账号强制 | SQLite 本地优先 |
| 团队 | YC 全职团队 | 个人项目 |
| 变现 | 未收口（YC 背景 → 云/团队服务后置） | — |

## 6. 双方独有功能

**Orca 有、CC-Panes 无**：Design Mode（真 Chromium 点选 UI 元素，HTML/CSS/截图直接喂 agent）、AI Diff 批注回传、Computer Use、一提示分发 ≤5 agent 对比合并、GitHub/Linear 应用内看板、账号切换与用量追踪（含 Claude 周用量表）、Android 模拟器流、`orca click/fill` 浏览器自动化、文件/图片拖入提示、近 30 代理适配、移动端已上架。

**CC-Panes 有、Orca 无**：Local History（版本+标签+分支感知）、共享记忆池、resume 会话链、Provider 多渠道热切换、Spec/Todo 绑定、Dev/Release 隔离并行运行、OSC 双通道状态机、中文优先工作流深度（skill 体系、plan→codex 交叉评审方法论）。

**Windows 深水区坑位对比**（CC-Panes 已踩、Orca 大概率未踩全）：DOM 渲染器防 CJK 花屏、Job Object 内核级清进程树、WebView2 失效自放大风暴、Vite watcher 事件风暴。

## 7. 源码级深挖

> 基于 `../references/orca` 本地快照的五维并行源码分析（2026-07-24）。仓库量级：源码约 200 万行、上万文件——main ~789k 行 / renderer ~993k 行 / shared ~123k / relay ~40k / CLI ~27k / mobile(RN+Expo) ~122k，测试约 3800 个文件（Vitest，co-located）。

### 7.1 编排系统：确定性调度器，不是 AI-in-loop

核心结论：**coordinator 不含 LLM**，是"确定性轮询调度器 + SQLite 状态机 + 进程内长轮询消息总线"。

- **持久层**：`{userData}/orchestration.db`（SQLite WAL，5 张表）：`tasks`（status ∈ pending/ready/dispatched/completed/failed/blocked，DAG 用 `deps` JSON 表达）、`messages`（type ∈ status/dispatch/worker_done/merge_ready/escalation/handoff/decision_gate/heartbeat；`read` 与 `delivered_at` 正交防重复注入）、`dispatch_contexts`（failure_count≥3 → `circuit_broken` 熔断）、`decision_gates`、`coordinator_runs`（同时仅一个 running）。所有查询带 UTF-8 字节+行数上限防超大行。
- **tick 循环**（默认 2s）：processMessages → 决策门状态自愈 → 心跳超 10min 只告警不自动失败 → dispatchReadyTasks（并发上限默认 4；无空闲终端每 tick 最多新建 1 个；派发前做 stale-base 漂移检查——落后 base >20 commits 且未标 allow 则跳过）→ 收敛检查。
- **派发的本质 = 把 preamble 提示词 paste 进 worker 终端的 PTY 并回车**（`sendTerminalAgentPrompt` → `buildAgentPromptPasteBytes` + `AGENT_PROMPT_SUBMIT`）。与 CC-Panes launch_task 注入同构——**且他们按 agent 声明 `promptInjectionMode`（argv/flag-prompt/stdin-after-start 等）+ 粘贴就绪信号，正面解决了多行 prompt 投递问题**（对照本仓库的 launch_task prompt 截断痼疾，这是现成参考实现）。
- **ask 阻塞机制**：服务端长轮询——插入 decision_gate 消息后 `waitForMessage` 挂在进程内 `OrchestrationMessageWaiterRegistry`（Promise + setTimeout 兜底 + AbortSignal + notify 唤醒；容量上限全局 1024/每 handle 64 防 DoS），被唤醒后按 thread 复查。默认 600s 超时。**无文件锁、无忙轮询**。
- **decision gate 生命周期**：worker 发 gate 消息或人工 gate-create → 任务置 `blocked` 并结束当前 dispatch → **只有人能 resolve**（协调器明确注释"从不自动解，否则审批检查点失效"）→ resolve 后任务回 `ready`，重派发时把 question+resolution 拼进 preamble 的 `DECISION GATE RESOLVED` 段。
- **worker_done 对账**：权限校验优先比对 `sender_pane_key` 与 dispatch 的 `assignee_pane_key`（pane 断连重连仍有效），不匹配转为 rejection——防串台/重试竞态。完成后 `promoteReadyTasks` 推进 DAG。
- **消息投递双通道**：持久化后 ①若目标 agent 状态 idle，主动把未投递消息 paste 进其 PTY（推送式注入）②唤醒其上阻塞的 `check --wait`/`ask` waiter。群发支持 `@all`/`@worktree:<id>`（fan-out 独立 read、共享 thread）。CLI 阻塞等待时每 15s 打 `_keepalive` 行防 Claude Code 判子进程挂起。
- **`terminal wait` 只有两种条件**：`exit`（进程退出）和 `tui-idle`（agent 转空闲；若卡在交互提示如 Codex trust/update prompt，返回 blockedReason 非零退出）。事件驱动 waiter + 超时兜底，先同步快查。比想象的简单——CC-Panes 补齐成本低。

关键文件：`src/main/runtime/orchestration/{db,coordinator,types,lifecycle-reconciliation,preamble,groups}.ts`、`orchestration-message-waiter-registry.ts`、`src/main/runtime/rpc/methods/orchestration*.ts`。

### 7.2 状态检测：hook 单主干 + OSC 9999 辅助，17+ agent 注入

三段式架构：shared 归一化层（`agent-hook-listener.ts`，4106 行，全部状态机所在）→ 主进程 loopback HTTP + 鉴权 + 跃迁守卫（`agent-hooks/server.ts`）→ relay 适配器（SSH/WSL 复用同一管线，"relay 归一化、Orca 路由"）。

- **状态集**：`working / blocked / waiting / done`（子 agent 另有 idle）。每个 agent 一个 `normalize<Agent>Event` 函数；Claude/Codex 各维护 lead 状态与 subagent 花名册分离的状态机（带 agent_id 的事件不污染 root 状态）。
- **hook 注入分四类**：①写配置 + managed shell 脚本 curl 投递（Claude/Codex/Gemini/Cursor 等——脚本先 source endpoint 文件刷新 port/token 应对 Orca 重启后 stale env，payload 走 stdin 防 EDR，`--connect-timeout 0.5 --max-time 1.5`，缺变量 fail-open exit 0）②Copilot 用 PowerShell Invoke-WebRequest ③OpenCode/Amp 生成整段 JS 插件源码注入其 Node 进程内 fetch 投递 ④Pi/OMP 内建 extension。Codex 特殊：需在 config.toml 写 trust 条目。
- **防抖去重四处**：持久化 250ms debounce + 无变化跳写；prompt-sent salted sha256 去重；OpenCode 插件端 250ms 节流 + 4000 字符 cap（服务器二次 cap 8000）；**跃迁守卫**——Ctrl+C 后 15s 内迟到的 working hook 不得复活已中断行、SSH relay 重启不得抹掉 resume/model 身份、connection watermark 防重连 replay 乱序。
- **推断兜底**：interrupt（Ctrl+C/双 Esc，按 agent 类型差异化）与 AskUserQuestion-answered 推断，严格 baseline 校验防迟到 timer 覆盖新 hook。transcript 未 flush 时 5 次 50ms 重试补 lastAssistantMessage。
- **OSC 9999 带内通道**（`agent-status-osc.ts`）：`\x1b]9999;` 前缀 JSON，流式解析跨 chunk 拼接（64KB pending 上限），per-PTY 处理后从数据流剥除。但只带 status 不带完整词汇，定位是辅助不是主干。标题派生行是正在移除的降级兜底。**信条与 CC-Panes 铁律一致："status comes from hooks — never inferred from terminal titles"。**
- **WSL 投递**（对 CC-Panes 最有参考价值）：WSL2 NAT 下 guest→Windows loopback 不通 → 在 guest 里**绑客户端已拿到的同一个端口**跑 guest-resident relay（未改动客户端零改动投递成功），信封经 host 独占的 wsl.exe stdio 转回主进程 `ingestRemote`（信任边界处**重新归一化**一遍）；endpoint 目录用 restart-stable instance key 而非易变端口；恢复前 `wsl --list --running` 探测且 fail-closed 绝不唤醒用户已关的 distro；无 node 的 distro 兜底走 `/mnt/c/Windows/System32/curl.exe`。
- **通知链路**：done → per-pane 完成协调器（1500ms 静默窗口去抖；requireFreshWorking 防启动误报；leaf-keyed PTY 活性门防 split-pane 迟到假通知；hook/title/process-exit 三源统一去重）→ 桌面通知 + 声音 + mobile push（WebSocket 事件流 + notificationSeq watermark 重放去重）。

### 7.3 终端 PTY 层：detached daemon + 文件 checkpoint

- **PTY 关在 detached daemon 子进程里**（fork + `detached:true` + unref + `ELECTRON_RUN_AS_NODE`），经 Unix socket/named pipe + token 通信。**Electron 退出只断 socket 不杀 daemon**——会话活过应用崩溃/重启；Windows packaged 下 daemon 宿主复制到 userData 逃出 NSIS 更新器 kill zone。与 CC-Panes 的持久终端 daemon（[17-persistent-terminal-daemon.md](./17-persistent-terminal-daemon.md)）同构，可互相印证设计。
- **持久化**：`userData/terminal-history/<session>/` 三件套——`meta.json`（endedAt=null 触发 cold restore）+ `checkpoint.json`（完整快照，tmp+rename 原子写）+ `output.log`（5s tick 只 append 增量，超上限触发完整 checkpoint 并重置）。daemon 侧用 `@xterm/headless` 做无头快照（不响应查询序列防与前台抢答）。
- **进程树清理是他们的弱项**：POSIX 用 tty/pgid killpg + lstart 时间戳防 PID 复用的后代 sweep（先快照后杀、SIGTERM→2s→SIGKILL）；**Windows 完全没有树杀**（无 taskkill /T、无 Job Object），只依赖 ConPTY 句柄关闭级联——**CC-Panes 的 taskkill /T + Job Object KILL_ON_JOB_CLOSE 双保险明确领先**。
- **背压三级**：①生产者流控——renderer-pending 水位 HIGH 256KB pause node-pty / LOW 32KB resume（宽滞回），pause 丢失有 5s 自动 resume + 5s 重断言双保险，patch 过 node-pty 让 Windows ConPTY pause 真背压 ②daemon pending 缓冲 2MB/4096 条上限 + 小 chunk coalesce（单条 64KB），溢出清空置标志退化为全量 snapshot ③backlog cap 随 scrollback 行数缩放 `max(2MB, rows*120)`。
- **WebGL 策略**：auto 档非 Linux 直接允许、Linux Wayland 禁用、软件渲染（llvmpipe 等）禁用；context loss 后退 DOM 渲染器。**未见 CJK 花屏针对性处理**（他们修的是 ZWJ emoji 宽度和 Nerd Font fallback）——CC-Panes"Windows auto 落 DOM"的经验仍是独有坑位知识。
- **`terminal read` 读的是 tail transcript 缓冲**（2000 行/256KB 滚动上限），cursor 分页只返回完成行（防 partial 行重复），带 truncated/oldestCursor 语义。
- 布局是二叉分割树，序列化直接遍历 DOM，恢复时重放 scrollback 并重置 SerializeAddon 带出的 mode 位（alt-screen 截断、mouse reporting 清理）。

### 7.4 Worktree 与文件监听

- **worktree 创建**：`git worktree add --no-track -b`（避免继承 upstream 误报 behind），写 `branch.<b>.base` 记血缘 + `push.autoSetupRemote`；180s 超时防 OneDrive 云占位符卡死；稀疏检出失败自动回滚。删除有锁检查、未合并保护（`-d` 优先、squash 场景证明已合并才删、删不掉返回 preservedBranch 绝不静默丢提交）、`update-ref -d` CAS 防删已移动分支。
- **趣味设计**：新 workspace 默认给"生物名"分支（`you/Nautilus`），首次真正干活时由 AI 按上下文改名为工作 slug（`first-work-branch-rename.ts`）。
- **"5 agent 并行对比"没有硬编码 fan-out**：就是每 worktree 独立建 + 同 prompt 复用投递，合并靠人在 diff 视图挑赢家，非自动合并。
- **git 状态刷新纯事件驱动，无轮询**（轮询仅剩 GitHub checks 面板和 30s 端口扫描）。watcher 用 `@parcel/watcher`，**跑在 fork 的独立子进程**（teardown race 会崩主进程 #7547）。参数对照 Superset：批处理上限 5000 事件（超限发 overflow 让渲染层保守全量刷新）、**150ms trailing + 500ms max-wait 双档 debounce**、同路径 coalesce、忽略表 `.git/node_modules/dist/build/.next/.cache/target/.venv/__pycache__`（镜像 VS Code）；macOS FSEvents 排除路径**最多 8 个且超限静默全丢**（实测 29x CPU）故前 8 高频目录进 daemon 排除、其余降级 userspace glob；渲染层再 125ms debounce 且面板不可见/未打开不刷新。三家（Orca/Superset/CC-Panes 目标态）在"事件驱动 + 分层限流 + .git 噪音过滤"上完全收敛，Local History 改造方向再获印证。
- **AI Diff 批注回传**：Monaco 行内批注 zone → Zustand slice 持久化 → `formatDiffComments` 拼 prompt → "Send notes to an agent" 投递到目标终端（submit-after-ready），发送后标记 sentAt。
- **端口双链路**：PTY 输出抓 advertised URL（换行处剥 ANSI 再扫 URL，per-PTY 4KB 缓冲，按 worktree+port 缓存并验 PID）+ 真实监听扫描（Linux 读 /proc/net/tcp、Windows netstat -ano，30s 间隔 + 超时退避到 5min）。
- **SSH 远程**：远端部署版本化 Node relay（install-lock、GC tombstone），SSH channel 多路复用承载 PTY/文件/git 三个 provider；重连退避 1s→30s 封顶、PTY incarnation 代际重挂、1s 窗口重放去重、grace period 0s~7 天可配。
- **性能事故记录**（`renderer-memory-profile-2026-06-01.md`）：教训三条——workingSetSize 在 macOS 把共享映射算进去导致误诊（改 RSS）；Codex TUI 每帧重绘 `Working` 文本被当 append-only 保留造成预览高 churn（保留前先应用 CR/backspace redraw）；非激活 worktree 卸载 webview 释放 guest renderer。

### 7.5 全景盘点补充

- **agent 适配是声明式集中注册表**（`tui-agent-config.ts`）：33 个 agent 每个一条配置（detectCmd/launchCmd/promptInjectionMode/draftPromptFlag/preflightTrust/windowsShiftEnterEncoding），加一个新 agent 最小改动 = 3 处类型化条目，编译器强制穷尽。少数 agent（Codex 最重）才有专属深度集成目录。**对照 CC-Panes 逐 agent 硬编码的路线，这是值得抄的结构**。
- **skill 体系**：8 个内置 skill（SKILL.md 格式与 Claude Skills 一致）+ 完整 guide 由 CLI 二进制运行时提供防版本漂移 + **主进程 skill 引擎能发现并消费第三方 Claude plugin skills**（含 WSL 路径）。
- **Automations**：60s tick 评估，前置检查含 agent 用量额度（ClaudeUsageStore/CodexUsageStore），支持远程主机无头调度。
- **Mobile**：React Native + Expo，与桌面走 JSON-RPC 帧协议，relay 中继 + 直连升级双路径，**端到端加密**（E2EE v2 key-schedule），配对/凭据轮换完整。
- **遥测**：PostHog，但 `TELEMETRY_ENABLED && IS_OFFICIAL_BUILD` 双门禁 fail-closed（dev/自编译构建拿 null 不发送），匿名 install-id 不建 person profile，burst-cap 限流先于 consent 检查。无强制账号/中心化后端；云依赖仅剩可选遥测 + 代码宿主 SaaS 集成 + agent 各自登录。

### 7.5b WSL 支持对比：复杂度构成与"项目运行时属性化"（2026-07-24 补充）

**Orca WSL 复杂度的三层拆解**：①WSL2 固有税（loopback 不对称/三套路径命名空间/WSLENV 边界/distro 碰即唤醒——我们同样在交，docs/18 的 NAT 探活、docs/35/36 的 UNC 伤疤即同款）②自选税——"17 家 hook 客户端零改动"约束逼出 guest-resident relay 冒充宿主收件的整套戏法（绑客户端已持端口 + wsl.exe stdio 回传 + mirrored 回退 + instance-key + 无 node 走 curl.exe），**我们 hook 客户端自有（cc-panes-cli-hook），此税不交**③矩阵爆炸（NAT/mirrored × node 有无 × distro 醒睡 × daemon 跨重启）。他们 2026-07 才台架验证、Codex 腿未实测；我们 WSL 生产数月——**链路深度我们领先，别被文档厚度吓到，厚度是补课痕迹**。**实机佐证（2026-07-24，用户 Windows 实测）**：Orca 的 CLI+Skills 安装引导第一步即报 `Error invoking remote method 'cli:install': Windows PATH command timed out after 5000ms`——Windows 路径核心流程未打磨；另其中文界面出现"2名儿童"级机翻（"2 children" worktree）。Windows + 中文双主场的判断获得实锤。

**但"WSL 跑 Windows 项目"场景他们没漏，且建模赢我们一手**（`src/shared/project-execution-runtime.ts` 专门模块）：
- **运行时是每项目属性**：`inherit-global | windows-host | wsl+distro` 三选 + 全局默认——D 盘项目可声明"在 WSL 跑"，与文件系统位置解耦
- **修复流**：WSL 不可用/distro 缺失 → 返回 repair-required 引导修复而非启动失败；旧配置自动迁移 + 降级留痕
- 路径双向翻译（`toLinuxPath`：UNC→Linux 与 `C:\`→`/mnt/c` 都处理）；hook 判定双方向（`isWslPath(path) || runtimeTarget?.wslDistro`）
- 反方向也细：仓库在 WSL 文件系统时全部经 `wsl.exe -d` 派进程（native git 打 9P "painfully slow"）、`fs.statSync` 对 9P 假报 ENOENT 改为进 distro `test -d` 问权威

**对照我方痛点**：同一项目按路径形态重复注册（cc-book 在 list_projects 里 4 条：D:\ + 三个 \\wsl.localhost），skill 须警告"projectPath 用 list_projects 原样字符串"。**行动项（P1 新增）："项目运行时属性化"**——一项目一实体 + runtime 偏好字段 + repair 流，消灭按路径形态的重复注册与"路径不匹配启动失败"故障类。注：docs/41 记录的"项目身份统一（跨形式等价 + 迁移去重）"已解决**识别**层等价，本项是**建模**层收口（注册与启动入口也归一）。

**他们未处理、我们独有的深水区知识**：D 盘项目在 WSL 内跑时 git 打 `/mnt`（9P）的性能税、Windows git 与 WSL git 混用同仓库的 autocrlf/index 锁风险——他们的 9P 优化只为"仓库在 WSL 侧"方向做,这两个坑无针对性处理;我们的日常用法即此场景,踩坑经验是独有资产,宜沉淀进 Known Gotchas。

### 7.6 CLI 能力发现机制：skill 就是 CLI 世界的 tools/list

Orca 走 CLI 面而非 MCP，核心难题是"MCP 有 `tools/list` 协议级发现，CLI 没有"。他们的解法是四层：

1. **stub skill 装进 agent 原生技能目录**：主进程 skill 引擎（`src/main/skills/`，16 文件）扫描并安装到 `~/.claude/skills`、仓库 `.claude/skills`、Claude plugin 缓存、WSL 路径；带安装拓扑分类（canonical-copy/provider-alias/broken-link 优先级）与 freshness 检查（版本更新自动刷新已装 stub）。agent 在自己的 skill 列表里"天然"看到 `orca-cli`——复用 agent 已有的发现通道，零协议
2. **stub 故意不写命令，完整手册由二进制现场吐**（`skill-stubs/orca-cli.md`）："kept out of this file on purpose so it can never drift from the binary"——stub 只教 agent 跑 `orca skills get orca-cli`，打印与当前二进制**版本精确匹配**的完整 CLI 手册。两三天一发版的命令面写死在 skill 里必然腐烂，让二进制自己当文档源永不漂移。stub 还明令"不要凭记忆或缓存猜子命令"，并含可执行文件解析顺序（`ORCA_CLI_COMMAND` env → dev → `orca-ide`(Linux 防撞 GNOME 读屏器) → `orca`）与老版本 fallback 协议
3. **派发时注入用法**：coordinator preamble 写明 taskId/dispatchId 与该跑的命令——在需要的那一刻喂需要的那几条
4. **env 信标**：`ORCA_CLI_COMMAND` 等标记"你在 Orca 管理下"；所有命令支持 `--json`

**与 MCP 发现机制的优劣对照**（结论：各有强项，混合最优）：

| 维度 | MCP tools/list | Orca 式 CLI+skill |
|---|---|---|
| 覆盖面 | 只有接了 MCP 的 agent | 任何有 skill/文档机制的终端 agent；连 skill 都没有的靠 preamble 注入兜底 |
| 发现新鲜度 | 协议保证每会话最新 | skill 文件会过期——Orca 靠整套 freshness 引擎 + 二进制吐手册补课 |
| token 成本 | 每会话预载全部工具 schema（实测数字见 §7.7） | stub 极小，全文按需加载（触发才 `skills get`） |
| 调用可靠性 | schema 强校验、结构化返回 | agent 自己拼 shell 命令，参数错误靠 `--json` 输出+文档质量兜底 |
| 结构化结果 | 原生 | 依赖 `--json` 约定 |

CC-Panes 的对应基础设施一件不缺：ccpanes 全局 skills（≈stub 分发）、launch_task prompt 注入（≈preamble）、`CC_PANES_*` env（≈信标）。唯一缺的是**"二进制现场吐版本匹配手册"**这一环——这条严格更优，值得直接抄。落地形态：`ccpanes` CLI 薄壳 + 现有 skills 改写为"stub + `ccpanes skills get`"模式；MCP 不废——接 MCP 的场景走 MCP（结构化校验），任意 CLI agent 走 CLI+skill，双腿并行，顺带削减 MCP 启动 token 开销。

### 7.7 能力面 token 账与 MCP/CLI 选型（2026-07-24 补充）

**实测：ccpanes MCP 的每会话固定 token 成本。** 对本机 dev 实例（0.10.21）`tools/list` 实测：**75 个工具、紧凑 JSON 40.7KB ≈ 10,000~12,000 token**（另加 server instructions 数百 token），占 200k 窗口 5~6%，每会话预载、全程占用。分布高度集中：`create_runtime_config` 一个占 4KB（18 顶层参数 × 三层嵌套子对象展开），launch_task 1.9KB，前 10 个工具占总量 1/3。**瘦身优先级按"schema 大小 ÷ 使用频率"排**，不是只看大小——launch_task 的 1.9KB 值得，create_runtime_config 的 4KB 是纯浪费（低频配置类操作）。注：docs/18 标题中的 "token" 指 `CC_PANES_API_TOKEN` 认证令牌，与本节 LLM token 成本无关，勿混引。

**方案梯子（按客户端能力分层，三层共享同一能力核心）：**

| 层 | 机制 | 覆盖 | 成本/代价 |
|---|---|---|---|
| ① 延迟加载 | Anthropic Tool Search Tool（`defer_loading: true`，检索命中后**追加**schema 不打碎 prompt cache） | Claude Code 新版 harness **已自动生效**（本调研会话实证：75 工具 deferred，只付工具名列表） | 零改动；仅救支持方。注意官方约束：搜索工具本身 + 至少一个工具不能 defer（全 defer 400）——高频核心（launch_task/get_session_status 等）常驻，低频延迟 |
| ② 网关 meta-tool | MCP 只暴露 `find_tool`（按需求搜工具返回 schema）+ `invoke_tool`（按名调用） | **所有 MCP 客户端**（Codex 等无延迟加载者的正解） | 服务器侧一层；失去 per-tool 客户端校验、调用两跳 |
| ③ CLI + skill | §7.6 四层发现机制 | 纯终端长尾 + 兜底 | 自建发现/文档链路 |

另有正交手段：**Programmatic Tool Calling**（agent 写代码调工具，中间结果不进上下文，官方数据最高 98.7% 削减）——CLI 路线在终端里天然获得同等效果（管道/循环组合命令，中间结果留 shell）。三层出口共享同一注册表/分发/文档生成，增量成本远小于三套系统。**CC-Panes 只需搭前两级**（①白拿 + ②给 Codex），CLI 降为"扩长尾适配面时的第三级"。

**MCP vs CLI 选型的本质（为什么 Orca 选 CLI 而 CC-Panes 不必跟）：** 把 per-agent 适配拆三块——①启动适配（launchCmd/prompt 注入方式）②hook/状态适配（各家 hook 机制注入）③命令面（agent 反控宿主）。**MCP 只覆盖③，①②无论走哪条路都逃不掉**（Orca 的 33 家 hook-service 矩阵、CC-Panes 的 cc-cli-adapters 同理）。Orca 选 CLI 的真实账本：CLI 把③的适配成本降到**零**（一个二进制 33 家通用）；若走 MCP，③变成全家最重的一块（33 种配置文件格式注入 × 端口/token/stale 配置运维故障面 × 日发 7 版的 schema 变更协调）。**MCP-first 正确的两个条件：客户端少而集中 + 工具面相对稳定——CC-Panes 双满足（Claude Code + Codex），Orca 双不满足（33 家 × 日发 7 版）。** 两个选择都对，参数不同。

**CC-Panes 已有同构的适配器矩阵（`cc-cli-adapters/`，8 家）：** claude 1291 行 / codex 1316 / grok 697 / opencode 404 / kimi 222 / glm 110 / cursor 81 / gemini 68，统一 `CliAdapter` trait 的 `build_command(ctx)`。**行数分布即证据：适配的贵不在启动（gemini 68 行）而在 MCP 注入 + 配置迁移 + hook 接线（codex 1316 行——stale config.toml 手术、trust 条目、WSL 路径，即 docs/18 修的那些）。** 与 Orca 的结构差异仅剩一点：Orca 瘦适配是纯数据注册表（`tui-agent-config.ts` 一条配置 + 共享启动引擎），CC-Panes 瘦适配是各写各的小 trait impl。若扩到 15+ 家，值得把"可执行名/prompt 传递方式/resume 参数格式"抽成声明式表 + 共享构建器，仅 claude/codex 级深度集成保留代码适配器（即行动清单 P1 第 5 条的具体含义——重构现有 8 个而非从零建）。

## 8. 战略判断

**"全面落后了吗"——不算，但要分开算：**

真落后（短期追不上）：① 火力与迭代速度（团队 vs 个人，不该追）② 社区飞轮（27k vs 490，MIT 免费传播阻力为零）③ 产品广度（30 适配、移动双端、Design Mode——人堆出来的面积）。

没落后：① **编排闭环纵深**（记忆/resume/Spec 是他们的空环，这是产品理解差距不是功能点差距）② **状态检测语义**（双通道 vs 单通道，他们刚走到我们几个月前的位置）③ **架构底子**（Tauri 内存差是数量级且结构性）④ **Windows 踩坑深度**。

要警惕：现有差异化项他们复制我们比我们复制他们快。护城河只能建在他们**结构上做不了**的地方：Tauri 资源占用、本地优先无账号（YC 迟早要账号体系变现）、中文/WSL 工作流贴身深度。

**定位结论**：作为"与 Orca 抢通用市场的产品"落后且难翻盘；作为"**Windows/WSL/中文场景最好用的本地优先编排器**"不落后甚至领先。Orca 的存在是免费的方向验证 + 抄作业来源。另一个务实选项：**兼容而非对抗**——MIT 许可 + 清晰 CLI 面意味着可以让 CC-Panes 编排"跑在 Orca 里的会话"，或把记忆池/resume 做成也服务 Orca 用户的独立层。

## 9. 行动清单

### 9.0 统一优先级排序（2026-07-24 定,跨 docs/43/44/45/47 全盘)

**第一波·修真 bug + 上保险(~3-4d)**
1. **bracketed-paste 投递**(docs/44 原语2,Phase A+B)——多行 prompt 截断是每天派工都在踩的活 bug;同时是 send_to_worker 的前置
2. **机器护栏套件**(45 P1-1,四个 vitest)——先上保险再动前端,行数棘轮冻结巨石、i18n 对等、禁裸文案、hex 色守卫

**第二波·双地基(~5-6d)**
3. **wait + send_to_worker**(docs/44 原语1/3)+ skill 收尾改写——退役全部手搓轮询;画布 Phase C 的边语义地基
4. **网关 meta-tool + 运行时挂载**(43 §7.7 梯子②)——Codex token 立省 + 画布能力边热插拔引擎,一鱼两吃

**第三波·前端主线(你点名的,~6-8d)**
5. **P1-6a 模块注册表 + 右坞宿主 + 现有面板迁移**(左导航右工具 IA 落地)
6. **P1-6b 会话历史面板**(注册表首个新住户)
7. 小件批:P0-4 侧栏折叠 + P0-5 spinner 时钟 + P1-8 创建菜单(三单可并行派)

**第四波·大赌注验证(2-3d,一票否决制)**
8. **画布 Phase A spike**(docs/47)——Windows 实机 8 会话不掉帧才继续;可提前浮动(与任何波并行,不占关键路径)

**第五波·增强池(按需取)**
9. P1-2 设置可搜索 → P1-3 状态可视化统一+会话行增密 → P1-4 in-flight 分级 → P1-5 通知合并 → P1-7 pane 命令入口 → 项目运行时属性化(43 §7.5b)→ 画布 Phase B/C
10. P2 池:浏览器 tab spike、引导体系、StatusBar 扩展、CacheTimer、快捷命令库、声明式适配注册表(扩适配面时)、记忆 v2(疼了再动,docs/16 rev.2)

**独立非工程线(用户亲自做)**:分发——npm/一键安装、双语 README、社区模板(CCB 3.3k★ 与 Hive 的启示:产品差距小于分发差距)

排序原则:①bracketed-paste 是唯一"现在就在流血"的项,无条件第一 ②原语与网关各解锁两条线(skill+画布 / token+热插拔),地基优先 ③P1-6 是用户实机体验后连续拍板项 ④画布 spike 便宜且有否决权,早验证早心安 ⑤重投入项(git 审查区/媒体节点)全部押后。

### P0（编排原语三件套 + prompt 投递，源码已验证实现成本低）

> **2026-07-24 更新**：经三道滤网（自身疼点/哲学契合/人力性价比）过滤后，P0 收敛为三件：`wait` + bracketed-paste 投递 + `send_to_worker` 下行，实施计划见 [44-orchestration-primitives.md](./44-orchestration-primitives.md)。decision gate、双向消息全集、DAG 等进"不做清单"留档。以下原始条目保留作参考。
1. **`wait` 条件等待**：Orca 只做了 `exit` 和 `tui-idle` 两种条件（事件驱动 waiter + 超时兜底 + blockedReason 报告），CC-Panes 状态机语义更全，补齐成本很低——替代轮询 get_session_status
2. **decision gate**：任务 blocked ↔ ready 状态切换 + 人工强制 resolve + resolution 拼进重派发 preamble——Orca 的 SQLite 实现可直接映射到现有 todo/task 表
3. **agent 双向消息**：SQLite 消息表 + 进程内 waiter 注册表长轮询（Promise + 超时兜底 + notify 唤醒）+ **idle 时推送注入 PTY**——`report_to_leader` 扩展为全双工的完整参考实现
4. **prompt 投递机制**（解决 launch_task 多行 prompt 截断）：Orca 按 agent 声明 `promptInjectionMode`（argv / flag-prompt / stdin-after-start）+ paste bytes + 粘贴就绪信号 + submit-after-ready——见 `tui-agent-config.ts` + `sendTerminalAgentPrompt`，是该痼疾的现成解法

### P1
5. **MCP token 瘦身（见 §7.7 实测与梯子）**：短期——按"schema 大小 ÷ 使用频率"压 create_runtime_config 等低频重 schema（深嵌套改 JSON 字符串参数）；中期——给 Codex 等无延迟加载客户端上**网关 meta-tool**（find_tool + invoke_tool）；Claude Code 延迟加载已自动生效，仅需把工具 description 写得可检索、保证高频核心工具常驻不 defer
6. **声明式 agent 适配注册表**：重构 `cc-cli-adapters/` 现有 8 个适配器——瘦适配（gemini/cursor/glm 级）抽成声明式表 + 共享构建器（仿 `tui-agent-config.ts`），claude/codex 级深度集成保留代码；扩代理适配面的前置工程
6b. **项目运行时属性化**（见 §7.5b）：仿 `project-execution-runtime.ts`——一项目一实体 + runtime 偏好字段（inherit-global/windows-host/wsl+distro）+ repair 流，替代按路径形态重复注册；建立在 docs/41 项目身份统一之上收口建模层
7. **WSL hook 投递加固**：guest-resident relay 绑同端口 + wsl.exe stdio 回传 + curl.exe 无 node 兜底 + restart-stable instance key（勿用易变端口做身份）
8. **CLI 薄壳 + 发现机制**（§7.7 梯子第③级，扩长尾适配面时才建）：`ccpanes xxx` 命令面包裹 MCP 能力（Orca 的 CLI→JSON-RPC→主进程结构可参考）。发现走 §7.6 四层方案：现有 ccpanes skills 改写为"stub + `ccpanes skills get <name>` 二进制吐版本匹配手册"，防文档漂移；全命令支持 `--json`
9. ~~**一提示多 agent fan-out 对比**~~ → **已降解为 skill 并实施**（`fanout-compare`，2026-07-24）：同 prompt × N worktree 并行 + barrier 监控 + 对比表 + 用户挑赢家 + 输家批量清理，复用 plantocodex 骨架与 worktree 隔离模式，零 Rust 改动。护栏：N≤3 + Rust 大仓库必须先报编译/磁盘成本（物理成本不因实现变便宜而消失）。支持"异模型对比"变体（同 prompt 分派 codex/claude）。**元结论：原语面健全时，Orca 功能清单的大部分条目在 CC-Panes 架构里不是功能缺口，是还没写的 skill——与 33 人团队的功能军备竞赛因此降维成写文档的速度竞赛，这是比 Tauri 轻量更硬的结构性优势。****worktree 相关最终决策**：worktree-as-project 概念成立（worktree 落进工作空间即自动继承配置，继承轴是 Workspace→Project），但以 **skill 先行**落地——plantocodex/plantocc 新增「worktree 隔离模式」章节 + `/plantoworktree` stub 入口 + finish-work 收尾检查（已实施，零 Rust 改动）；固化为产品功能（kind/parent_project_id 字段 + 侧栏嵌套）的触发条件 = 使用频率上来。唯一遗留 Rust 债：`remove_project_from_workspace` MCP 工具（带确认语义），skill 期"UI 手点移除"够用
10. **Local History 事件化**（与 42 号文档 P0 合并推进）：三家已在"事件驱动 + 分层限流 + .git 噪音过滤"收敛；Orca 参数可参照（5000 事件批上限 + overflow 降级、150/500ms 双档 debounce、VS Code 忽略表、watcher 进程隔离防 native crash）

### P2
11. AI Diff 批注回传（Monaco zone → 格式化 → submit-after-ready 投递）、agent 用量追踪、"生物名分支 + AI 首次干活改名"
12. 观察其变现动作（PostHog 遥测已双门禁、无账号强制；一旦引入账号体系是本地优先姿态的宣传窗口）

### 已确认的 CC-Panes 领先项（守住勿退）
- **Windows 进程树清理**：Orca 在 Windows 无树杀（无 taskkill /T、无 Job Object，纯赖 ConPTY 句柄级联）；CC-Panes 的 taskkill /T + Job Object 双保险明确更强
- **CJK 渲染坑位知识**：Orca 的 WebGL auto 策略只防 Linux 软件渲染，未处理 Windows WebGL CJK 花屏
- **OSC+hook 双通道状态机**：Orca 的 OSC 9999 只是辅助通道且不带完整词汇；hook 单主干 vs CC-Panes 双通道去重
- **持久终端 daemon**：两家同构（detached daemon + checkpoint），CC-Panes 已有，非差距项

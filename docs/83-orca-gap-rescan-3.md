# 83. Orca 竞品功能差距重扫（0.11.13 基线，第三轮）

> 扫描日期：2026-08-07。CC-Panes 基线：`main@e844df7`（v0.11.13，2026-08-05；工作树另有 feat/0120-tab-lifecycle 的 M3b checkpoint 实现提交，按口径记 🚧）；Orca 基线：本地快照 `../references/orca` @ `f713739`（origin/main，2026-08-06，07-23 以来 1084 提交）。本文是源码级研究，不代表 Windows 桌面实机验收。上一轮见 [55-competitor-gap-rescan.md](./55-competitor-gap-rescan.md)（0.11.1 基线）。附录 A 含早期时间线对比。

## 1. 结论摘要

本轮六域共归并 **约 70 个可判定项**：**✅ 22、🚧 10、📋 23、🗑️ 15**。全部关键判定经主会话抽查双侧源码证据核实。

相对 55 最重要的七个变化：

1. **55 的 A2 ✅ 高估了 CCP 的耐久层，需降为 🚧**。已发布态只有 8MB 内存 ReplayBuffer（daemon 死即全灭）+ 退出时落盘的**剥色纯文本行**；Orca 是 daemon 侧 headless emulator 生成的带 ANSI/scrollback/modes 的 checkpoint + 带撕裂检测的帧式增量 log + 隔离/墓碑/GC 三件套。M3b（feat 分支）已落 Rust 半程，是本域最优先收尾项——但「照片由前端拍」意味着桌面关闭后长期后台会话仍无高保真基线，收尾前须先拍板此口径。
2. **`get_session_output` 是 55 里唯一跨两个版本零位移的 P0**：`SessionOutput { session_id, lines }` 至今无 cursor/truncated 语义（`terminal_service.rs:530`），而 Orca 同期已是六字段成熟协议 + 完成行专属 + 空白回退（`orca-runtime.ts:36201`）。M3b 正在给 ReplayBuffer 加 seq 锚点，行游标搭这趟车的边际成本最低——错过窗口要单独再造记账。
3. **两条 55 结论被代码反转**：H7「parked terminal 不做」——`useTerminalHibernation.ts` 的 serialize+dispose 正是该方案且已落地（应作废不做结论，但配套可观测性为零，见 T8/T10/T13）；浏览器 D1/D2——native browser tab MVP + 5 个 MCP 工具的 CDP 自动化已合入 main，55「连基础 tab 尚未落地」整段过时，唯一缺口收窄为动作集（无 fill/type/press/wait）。
4. **Orca 的 decision gate 与 DAG 都没有 55 想象的产品化**：gate 在 renderer/preload 零命中（人只能敲 CLI 解闸）；coordinator 的 decompose 无任务直接 throw（"decomposition isn't implemented yet"）。A4 降 P2、A6 维持 🗑️ 且理由加固。反向：CCP 的 ai-panel 投递回执（delivery 五态）在「人在回路」上**领先** Orca，55 漏记了这一笔。
5. **编排域唯一咬人的缺口是派工熔断**（升 P0）：CCP 的派工失败是「内存态补投队列 + 终端退出即 failed」，无失败账本、无熔断、无人工复位——并行 worker 规模上升后会静默腐坏。Orca 已细到「drift 拒派不烧熔断预算」「failure_count 跨重试 MAX 结转」。
6. **Provider 架构是本轮唯一的确定性反超，且 Orca 结构上走不回来**：Orca 全库非测试代码仅 2 处提到 `ANTHROPIC_BASE_URL`，shared 层 `contextWindow` 零命中——其产品线绑死「官方订阅+额度管理」（accounts+rate-limits 共 1.8 万行沉没成本）。CCP 的 `provider_resolver.rs` 三元溯源 + docs/82 窗口语义解决的是 Orca 定义域外的问题。只需 55 G2 的只读额度展示（2-3d）堵官方订阅用户侧翼。
7. **面积≠优先级本轮比 55 更极端**：Orca 07-23 以来 1084 提交（插件系统 7203 行、agent map 2207 行、5 语种 74027 行 locale、updater 三渠道 8897 行），真正值得 CCP 迁移的合计**不到 8 个工程日**（崩溃面包屑/OOM 归因、skill 更新收敛、通知补投协议）。

判断口径沿用 55 §2：✅ = 核心用户目标可完成（允许机制不同）；🚧 = 有实现提交（仅建分支不算）；后端存在但 UI 未接线不算完成（对 Orca 对称适用）；工量为 1 名熟悉仓库工程师的工程日。

## 2. 扫描范围与证据口径

- 六个并行研究 agent 逐域扫描双侧源码（每项要求真实文件路径证据），主会话对每域至少 1 条关键判定亲自复核（SessionOutput 结构、Orca gate 零 GUI、gitService 只读方法表、`worktree remove --force`、移动端重连常量无消费点、Orca shared 层 contextWindow 零命中——全部属实）。
- Orca 侧增量以 `git log HEAD(07-23)..origin/main(08-06)` 聚类定位（fix(mobile) 75 / fix(terminal) 73 / fix(runtime) 28 …），再进源码验证。
- CCP 侧以 `main@e844df7` 已提交代码为准；`534739b..main` 为 0.11.2→0.11.13 增量。

## 3. 终端 / PTY / daemon / 恢复（T 系列）

| # | 项 | 判定 | 55→83 | 要点 | 工量/优先级 |
|---|---|---|---|---|---|
| T1 | 有界输出读取契约（cursor/truncated） | 📋 | A3 📋 → 📋 零位移 | CCP `SessionOutput{session_id,lines}` 尾部 N 行（`terminal_service.rs:527-533`，MCP 出口无 cursor）；Orca `readTerminalTail` 六字段协议+完成行专属+字符预算+空白回退（`orca-runtime.ts:36201-36314`） | **1.5-2d / P0**（搭 M3b seq 锚点的车） |
| T2 | daemon→app 背压与丢弃语义 | ✅ | 新增 | CCP 有界 256+desync 契约+前端 snapshot 重放闭环（`ws_emitter.rs:19-29`、`terminalResync.ts`）；Orca 走保尾丢头+dataGap。机制不同、目标都达成，不建议改 | — |
| T3 | 渲染端写入流控 | ✅ | 新增 | `terminalWriteFlowControl.ts` 128KB 采样+水位背压，已接线 | — |
| T4 | 远程 PTY 信用制流控 | 📋 | E3 拆出 | CCP 弱网下被动 desync 重拉全屏；Orca `pty-source-credit-*` 完整信用账本 | 4-6d / P2（等移动端重度使用再做） |
| T5 | 持久化/checkpoint | **🚧** | **A2 ✅ → 🚧 降级** | 已发布态：8MB ReplayBuffer + 退出时剥色文本行（`session_output_store.rs`）；Orca 三件套（headless emulator checkpoint + OCKL 撕裂检测帧 log + 隔离/墓碑/GC）。M3b 已落 REST 上传端点/seq 贯通/补拍扫描 | 剩余 4-6d / **P0**（收尾前拍板「照片由谁生成」） |
| T6 | 进程树清理 | ✅ 反超 | A2 ✅ 维持+追记 | Job Object `KILL_ON_JOB_CLOSE` 仍是双方唯一的宿主暴毙兜底（Orca 无，仅 #10680 待办）；但 CCP 裸 `taskkill /T`（`pty/mod.rs:440-470`）无 PID 复用身份校验，Orca `killWithDescendantSweep` 先验身份再树杀 | 补校验 0.5-1d / P1 |
| T7 | 后台休眠/分层降档 | **✅** | **H7 🗑️ → ✅ 反转** | `useTerminalHibernation.ts` serialize+dispose 两档（5min WebGL / 30min 休眠）+安全门齐备；Orca park 面积更大（30+ 文件）但主线对齐 | — |
| T8 | 手动停靠/降档可观测 | 📋 | 新增 | CCP 无手动入口、无档位可见状态；Orca 有开发者菜单 Park + 判定翻转遥测 | 0.5-1d / P1 |
| T9 | 跨 daemon 边界契约/版本门控 | ✅+📋 | 新增拆两态 | `boundary_events.rs` 五维契约表+穷举守卫是**双方独有**的反超面；缺数字化 `PROTOCOL_VERSION`（现为逐能力 404 探测，会组合爆炸） | 1-1.5d / P1（T5 上线前收口） |
| T10 | OS 挂起/唤醒归因 | 📋 | 新增 | CCP 零电源事件订阅，合盖唤醒后异常无归因；Orca `system-resume-broadcast.ts` + 崩溃面包屑区分「睡了」与「冻结」 | 1.5-2d / P1 |
| T11 | 冷恢复/异常退出恢复 | ✅ | A2 维持 | docs/81 六态决策表已接线（`canColdRestore`），且 resumeId 注入让对话本身接续（Orca 无此层）；画面保真度差距全在 T5 | —（并入 T5） |
| T12 | daemon 生命周期遥测 | 🗑️ | G4 维持 | 产品遥测与本地优先冲突；代际字段留给本地诊断包 | — |
| T13 | 崩溃面包屑/内存高水位 | 📋 | G5 📋 升级 | 休眠刚上线却无内存观测，收益回归均不可证；Orca 能答「崩溃前哪个 map 长了多少字节」 | 1.5-2d / P1（与 T8/T10 打包「休眠可观测性」批次，合计 3.5-5d） |

## 4. 编排 / agent 状态 / 可视化（O 系列）

| # | 项 | 判定 | 55→83 | 要点 | 工量/优先级 |
|---|---|---|---|---|---|
| O1 | Decision gate | 📋 | A4 P1 → **P2 降档** | Orca gate 无任何 GUI（renderer 零命中，人敲 CLI 解闸），非产品化；CCP ai-panel 带回执问询已覆盖 80% 场景，缺的是任务级 blocked 不变式+resolution 审计 | 1.5-2d / P2 |
| O2 | 派工失败熔断 | 📋 | A5 P1 → **P0 升档** | CCP 仅内存态补投队列（`orchestrator_service.rs:11076`）+「终端退出即 failed」，无账本/熔断/复位；Orca failure_count 跨重试 MAX 结转、drift 拒派不烧预算、幂等对账五种拒绝码 | **2d / P0（本域最高）** |
| O3 | 双向消息/邮箱 | ✅+🗑️+📋 | A1 ✅ / A7 🗑️ 维持 | leader↔worker 双向闭环（busy 排队+空闲边沿补投）不输 Orca；thread/群发/read 维持不做；新拆「worker 阻塞 ask leader」📋 P3（现有 waiting 上报够用，实测阻塞再做） | ask 1-1.5d / P3 |
| O4 | 任务 DAG | 🗑️ | A6 维持+加固 | Orca 6807 行 db.ts 换来的只是「依赖就绪即派」，上游 decompose 明写未实现（无任务直接 throw）；CCP leader+skill 等价 | —（如做只做 `metadata.blockedBy` 软依赖 0.5d） |
| O5 | 编排可视化 | 🚧 | 新列 | CCP 已有 ~4272 行运行时监控（列表/树/详情/输出预览），应记 🚧 非 📋；Orca 128 文件的 map/rings/board 自己关在实验区，不追 | 地图不做 |
| O6 | 开发台账（docs/74） | 📋 | 新列 | `archived_at` 零命中、`ledger` 在 web/ 零文件，四批次一个未开工——这是 CCP 独有痛点（worktree 匿名淹没）而非抄袭项 | 批次1-2 共 3-4d / **P1**（与 O2 打包「编排可靠性+收尾」发版） |
| O7 | agent 适配面广度 | 🚧 | 新列 | CCP 8 个 Rust 适配 vs Orca 34 启动/14 状态检测的声明式单表；但 CCP 单 agent 纵深更深（HTTP+OSC 双通道、投递就绪态独立判定，Orca 无此区分）。扩容候选：copilot/droid/amp/qwen-code/trae + **pi/omp**（两家共享 `PI_CODING_AGENT_DIR` 扩展契约，接一得二；Orca 集成参考 `src/main/pi/`——状态/prefill/标题栏走 pi 自有扩展 API 注入，prompt 预填用 `ORCA_PI_PREFILL` 环境变量绕开粘贴竞态，Windows Shift+Enter 需 CSI-u；注意 pi 是里程碑型 agent，步骤间发 `agent_end` 仍在干活，状态机须区分；CCP 侧扩展里 POST 自有 cli-hook 通道即可，比 Orca 少一层兼容约束） | 声明式化 3-4d / P2，再按呼声补 3-5 家 |

## 5. Git / 源码控制 / 集成（G 系列）

| # | 项 | 判定 | 55→83 | 要点 | 工量/优先级 |
|---|---|---|---|---|---|
| G1 | 右坞 Git 写操作 | 📋 | C2 维持+**恶化一层** | pull/push/stash 的 Rust 命令在而 TS 零消费（`gitService.ts` 仅 7 只读方法）；**stage/commit/discard 连 Rust 命令都不存在**——不是接线是补齐 | 5-7d（上修）/ P1 |
| G2 | PR/Checks/Review 闭环 | 📋 | C3 维持，差距扩大 | Orca 已从 2 家扩到 5 家 forge + hosted-review 状态机；CCP 零。只做 GitHub 窄 MVP（changed files+checks+批注列表），**不抄 forge 抽象** | 6-9d / P1（窄） |
| G3 | worktree 生命周期 | **🚧** | **E4 ✅ → 🚧 下修** | `add_worktree` 无 base ref 参数、`remove_worktree` 硬编码 `--force` 不查脏工作区（`worktree_service.rs:202`）、无回收站——三个「误操作丢工作」口子，被 plantoworktree/fanout skill 的批量建删放大；docs/62 项目卫生是本域唯一优质增量（三态判定建模优于 Orca 往 WorktreeMeta 塞 7 个外部平台 ID） | base+脏检查 1.5-2.5d / **P0** |
| G4 | sharedDirectories/.worktreeinclude | 🗑️ | 新增 | 纯文件拷贝/symlink，skill 一段提示即可承接（plantoworktree 建完执行），不产品化 | skill 0.5d / P2 |
| G5 | Issue 集成（Jira/Linear/GH） | 🗑️ | C5 维持 | 警惕点变了：Orca 已把 7 个 `linked*` 外部平台字段写进 WorktreeMeta——典型模型污染，CCP 勿仿；需要时 skill 调 `gh issue view` 生成本地 Todo | — |
| G6 | AI Diff 批注回传 | 📋 | P2 维持+重定性 | 不是 Git 功能，是 CCP 编排优势的延伸：diff 数据+submit_to_session 原语都在，缺一根「选中批注→拼 prompt→投递」的线；不抄 Orca 的 recipe 持久化 | 2-3d / P2（本域性价比最高） |
| G7 | Source Control 交互细节 | 🗑️ | 新增 | Cmd+Enter/copy path/detached 过滤是 Orca 对已有面板的打磨，CCP 无面板则无意义，随 G1 一起做 | — |

## 6. 浏览器 / 编辑器 / UI 面板（U 系列）

| # | 项 | 判定 | 55→83 | 要点 | 工量/优先级 |
|---|---|---|---|---|---|
| U1 | 内嵌浏览器基础闭环 | **✅** | **D1 🚧 → ✅** | tab UI 完整（地址栏/导航/devtools/安全指示/bounds 同步/遮挡兜底）+ paneId 落位 + 同 URL 复用；缺的是周边件（页内查找/缩放/下载/错误页恢复） | 周边件 2-3d / P2 |
| U2 | agent-browser 自动化 | **🚧** | **D2 📋 → 🚧** | 5 个 MCP 工具（navigate/evaluate/screenshot/click）+ 通用 `call_cdp` 已落地，且解决了 Orca 没面对的「tab 落到调用方 agent 自己的布局」；但无选择器语义、无 fill/type/press/select/wait——agent 能看不能操作 | **3-5d / P0**（通道已通只差动作集，本域投入产出比最高） |
| U3 | Design Mode/点选回传/视口仿真 | 📋 | 拆出 | Orca grab+markup+annotation 投递闭环 CCP 零件皆无；视口仿真（`Emulation.setDeviceMetricsOverride`）可单拆 1d | 5-8d / P2；视口仿真 1d / P1 |
| U4 | 编辑器能力面 | 🚧 | 新列（55 盲区） | CCP Monaco 基座+md 预览/Mermaid/分栏同步 2741 行 vs Orca 441 文件文档工作站；只取 word wrap 切换+外部改动横幅+PDF 查看+md 目录（4-5d）；**富 md 所见即所得判 🗑️**（tiptap 双序列化管线长期债） | 4-5d / P1（分档） |
| U5 | 模块注册表 | ✅ | B2 ✅ 扩展 | 已 6 模块+右坞 5 视图，架构反超（Orca 是固定宿主无注册表）；但 orchestration/resources/todo 声明了 rightDock surface 而 `RightDockView` 无对应分支——**声明与实现不同步的契约漏洞** | 补三视图 1.5-2d / P1 |
| U6 | 布局系统 | ✅ | 新列 | 预设+星标镜像+状态三重编码卡片（docs/75）是 Orca 没有的；Orca dashboard 归 O5 | — |
| U7 | 设置体系 | ✅ | B2 维持 | 机制对齐；边界注记：ExperimentalSection 是空壳（毕业机制在、暂无在栏项） | — |
| U8 | Quick Open/命令面板 | 🚧 | B3 ✅ / B4 📋→✅ / 新拆文件打开 🚧 | 快捷命令三层已齐（含逐条禁用理由，比 Orca 严谨）；但 `RecentFilesPicker` 只搜已开过的文件，**打不开没开过的文件** | **1.5-2d / P0**（日频最高、纯前端接线） |
| U9 | 主题与外观 | ✅ | H5 🗑️ 维持 | 6 预设+实时预览+壁纸+token 收口；第三方主题导入维持不做 | — |

## 7. 移动端 / 远程 / SSH（M/R/S 系列）

| # | 项 | 判定 | 55→83 | 要点 | 工量/优先级 |
|---|---|---|---|---|---|
| M1/M2 | 移动终端查看/输入 + 会话控制 | ✅ | F1 拆分维持 | 镜像闭环齐全；CCP 的布局镜像+孤儿判定语义比 Orca 平铺 tab 更贴桌面主场 | — |
| M3 | 移动端断线重连/后台恢复 | **🚧** | **F1 拆出降级** | `config.dart:9-11` 重连常量注释「Phase 3 使用」却**无任何消费点**；锁屏回来停在死 socket 上。Orca 有完整 reconnect-controller+前台重拨 | **2-3d / P0**（本域唯一每天打脸项，M4/M5 前置） |
| M4 | 移动推送通知 | 📋 | F2 拆出，优先于配对 | `cc-panes-web/main.rs:566` 显式 NoopNotifier——桌面侧 589 行通知语义完备但不外溢；Orca 复用长连接当推送通道+`getMissedSince(seq,epoch)` 补投，**明确不引 FCM/APNs，与 CCP 定位完全兼容，本轮唯一可近乎直抄的架构**（注意 epoch 教训） | 4-6d / P1 |
| M5 | QR 配对/设备注册表/E2EE | 📋 | F2 维持，量级上升 | CCP 单密码打天下、无法撤销单台设备；先做注册表+每设备 token+撤销，QR 是录入体验，E2EE v2 不抄 | 5-8d / P1（排 M3/M4 后） |
| M6 | 移动高阶面（native-chat 等） | 🗑️ | F3 维持 | Orca 移动端 1171 个 TS 文件 vs CCP 25 个 dart——他们造第二套桌面，我们造遥控器，定位差异非落后 | — |
| M7 | iOS 发布链路 | 🚧 | 新增 | ios 目录在、TestFlight 未走；近 5 周 27 次 mobile 提交 21 次是版本 bump（实质停更） | 5-8d / P2（Android 体验坐实前不上） |
| R1 | 云 relay+直连升级 | 🗑️+📋 | 拆分 | 托管 relay 绑云账号，明确不做；只补「Tailscale/反代自检+可达地址探测」引导 | 引导 1-2d / P2 |
| R2 | 来源分级+远程只读 | ✅ **反超** | 新增 | `web_auth.rs` classify_origin+READ_ONLY_POST_ALLOWLIST+effective_read_only 是 Orca 没有的安全纵深；做 M5 时**勿用 token 模型替换它**，要正交叠加 | —（守住） |
| R3 | headless/VPS 服务端 | 🚧 | 新增，**隐性缺口** | `cc-panes-web` 已是独立 Rust 二进制+Docker+40 路由文件，离 `orca serve` 不远；堵点：NoopNotifier、无启动横幅播报 endpoint/配对、无首启引导 | 2-3d / **P1**（把 80% 已有资产变现的最短路径，M4 的落地宿主） |
| R4 | headless CLI 账号/skills | 📋 | 新增 | Orca `orca account add/list` 专为远端设计；CCP ctl 无登录/skills 入口 | 3-4d / P2（R3 不做则无意义） |
| S1 | SSH 机器管理 | ✅ | E1 维持 | 三层贯通且是唯一同时在 Tauri+Web 两宿主暴露的 | — |
| S2 | `~/.ssh/config` 导入 | 📋 | E3 拆出 | Orca 有完整 parser/Include 展开/host picker/ProxyCommand；CCP 逐台手抄、跳板机不可用——SSH 域成本最低覆盖最广的一项 | 2-3d / P1 |
| S3 | 远端 relay 部署 | **🗑️** | **E3 📋 → 🗑️ 下调** | Orca relay 约 230 文件+版本化安装/锁/GC/原生依赖，重估 12-20d；CCP 是 Rust 栈无 Node 前提，照抄=新增一条发行链 | 不做 |
| S4 | SSH 断线重连/会话存活 | 📋 | E3 拆出 | 网络一抖远端 agent 会话即丢；走 `ControlMaster`+远端 tmux 拿 80% 价值，只抄 Orca 一条定理：退避上限必须小于远端 grace 期（`ssh-reconnect-ladder.ts`） | 5-7d / P1（SSH 域第一） |
| S5 | SFTP/端口转发 | 🗑️ | E3 📋 → 🗑️ | scp/rsync 肌肉记忆+Tailscale 替代 | — |
| S6 | WSL 链路 | ✅ 领先 | E1/E4 维持 | 守住；project-execution-runtime 建模收口维持 55 E2 📋 不变 | — |

## 8. 新面积专扫（N 系列）

| # | 项 | 判定 | 要点 | 工量/优先级 |
|---|---|---|---|---|
| N1 | Orca 插件系统+marketplace v0 | 🗑️（完整）/📋（降维） | 108 文件 7203 行 kernel+能力闭集+consent+kill-list，renderer 全接线——但真正不可降维的只有供应链信任段，且 Orca 自己把 skills 从 contributes 里 deferred 了。**暴露的是 CCP 侧真缺口：skill market 是裸 HTTPS 拉 raw JSON，无签名/内容哈希/吊销** | skill market 供应链加固 3-5d / P1.5 |
| N2 | speech/dictation 本地 STT | 📋 | Orca 10+ 本地模型（sherpa-onnx+HF 不可变 revision+逐文件 SHA-256）；CCP 纯云端（dashscope/mimo）。差的是隐私边界不是功能（55 H2 ✅ 仍成立） | 本地单模型 4-6d / P2；麦克风选择等体验补丁 0.5d |
| N3a | 用量计价口径 | ✅ | CCP docs/82 上下文窗口溯源反超（Orca shared 层 contextWindow 零命中）；仅价格表数值滞后 | 0.5d / P2 |
| N3b | 多 CLI 账号+额度 | 📋 | Orca accounts+rate-limits 共 1.8 万行；CCP 只做只读额度展示堵侧翼，不碰凭据管理 | 2-3d / P2（55 G2 维持） |
| N4 | updater 多渠道 | 🗑️ | hourly/adhoc 独立仓+本地 feed server 8897 行——解决的是 20 人团队的内部研发流程，单人维护做三渠道是自残 | — |
| N5 | diagnostics/crash 遥测 | 📋 | OOM 字节归因+hang watchdog（worker thread）+suspend 区分+observability redactor/bundle；只取本地脱敏包，不取 upload（G4 🗑️ 沿袭）。与 T13 同源 | 2-3d+2-3d / P1.5（G5 升级） |
| N6 | Orca skills 更新收敛 | 📋 | Orca 把 skill 当受管资产（版本收敛/失败可诊断/缓存上限）；CCP 的 skill 服务无更新收敛与失败告知——**护城河上的真实薄弱点** | 1.5-2.5d / P2 |
| N7 | 其他漏网 | 🗑️ 为主 | ephemeral VM（WSL/worktree 已覆盖）、5 语种 locale 74027 行（市场策略）、Azure DevOps/Bitbucket/Gitea（C5 覆盖）、star-nag、text-generation（skill 可替代）；project-groups 并入 55 E2；attribution 等 G1 做了再看 | — |
| N8 | CCP Provider 架构 | ✅ **反超** | `provider_service.rs` 1788 行+`provider_resolver.rs` 1230 行三元溯源+UI 全接线+docs/77/82；Orca 的 providers/ 目录是运行时抽象不是 API 渠道，第三方中转零配置面——**结构性走不回来**（1.8 万行账号路线沉没成本） | —（守住） |
| N9 | CCP 快捷命令/tips/打扰闸门/资源弹层 | ✅ | 55 B4 P0 已交付；打扰闸门显式化比 Orca 的 startup-gate 清晰；资源监控与 Orca memory/ 对等且按会话归组更深 | 命令面板接快捷命令确认 0.5d |
| N10 | CCP 会话历史索引 | 🚧 | ~1300 行+右坞已接线（55 B8 MVP 达成）；差跨 CLI 广度与摘要/计数 | 收尾 1-2d + 扩展 2-3d / P1 |

## 9. Top 5 建议（0.11.14 / 0.12 抓手）

按「先堵正确性口子、再收已投入的尾、后补高频体验」排序：

1. **小件安全批（~4-5d）**：G3 worktree base ref+脏工作区拦截（P0, 1.5-2.5d）+ T6 kill 前 PID 身份校验（P1, 0.5-1d）+ N1 skill market 内容哈希/签名/吊销（P1.5, 3-5d 可裁剪）。全是「一次误操作/一次投毒就出事」的口子，且互相独立可并行派工。
2. **输出契约搭 M3b 的车（T1+T5, P0）**：M3b checkpoint 收尾（剩 4-6d，先拍板「照片由谁生成」口径）时顺路把 `get_session_output` 接上 seq 锚点做成 cursor/truncated 协议（1.5-2d）——55 里唯一零位移的 P0，时间窗就是现在。
3. **编排可靠性+收尾包（O2+O6, ~5-6d）**：派工熔断（P0, 2d：失败账本+3 次熔断+复位按钮）+ docs/74 台账批次 1-2（P1, 3-4d）。一个管「别静默烂」，一个管「烂了能盘点」，共用审计模型。
4. **browser 动作集（U2, P0, 3-5d）**：CDP 通道/tabId/布局落位全在，补 snapshot/fill/type/press/wait 即把「agent 自验网页」从演示变日常闭环；顺手 U3 视口仿真 1d。
5. **移动/远程最小可靠化（M3+R3, ~5d）**：移动端 socket 重连+前台重拨（P0, 2-3d）+ cc-panes-web 启动横幅播报 endpoint/接通 notifier（P1, 2-3d）。前者止血，后者把 80% 已有 headless 资产变现，并为 M4 通知管道（P1, 4-6d，可直抄 Orca 的 seq+epoch 补投协议）铺路。

落选说明：G1 右坞 Git 写操作（5-7d）价值高但依赖产品决断（是否要做完整 Source Control 面板），建议独立立项；U8 quick open 文件打开（1.5-2d）与 U5 右坞三视图接线（1.5-2d）是最好的「新人练手/小件」候选。

## 附录 A：早期时间线对比（2026-08 考证，完整历史 unshallow 后）

起点：CCP 首提交 2026-02-16，Orca Initial commit 2026-03-16（修正 43 号文档的 03-17，day 1 即有 "Basic terminal support"）——CCP 早整月且 03-05 已开源。火力：Orca 4.7 个月 8095 提交 / 827 tag（月峰 2762），CCP 同期 862（squash 为主）。

| 能力 | CCP | Orca | 先后 |
|---|---|---|---|
| 基础终端 / worktree | 02-16 | 03-16 / 03-21 | CCP 早 28-33 天 |
| MCP/编排控制面 | 03-10 | 04-03 | CCP 早 24 天 |
| 会话状态检测 | 03-17 | 04-11~25 | CCP 早约 1 月 |
| SSH / WSL | 03-19 / 03-28 | 04-13 / 04-07 | CCP 早 |
| 浏览器 tab | 2026-07 | **04-10** | Orca 早约 3 月 |
| daemon 持久终端 | 06-20 | **04-17** | Orca 早 64 天 |
| leader-worker 编排 | 05-14 | **04-28** | Orca 早 2 周（43 §2：双向排除抄袭窗口） |
| 移动端 | 07-05 | **05-04** | Orca 早 2 月 |
| 发版工程 | 03-05 起 | **03-19=开工第 3 天** | 同期，但按项目年龄 Orca 快 |

结论：方向性判断 CCP 全部在先；差距集中在平台面积项（daemon/浏览器/移动端/发版工程，按项目年龄 Orca 快 2-4 倍，团队火力直接兑换），以及 day-3 发版所代表的起步工程化程度。与本轮扫描互证：被日历反超的三条线（daemon 持久化、浏览器、移动端）正是 83 判定里 🚧/📋 最密集的三个域。

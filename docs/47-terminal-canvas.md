# 47. 终端无限画布(Terminal Canvas)设计

> 状态:构想已定型,待 spike 验证
> 来源:2026-07-24 用户提出。背景痛点:会话数量已超出 tab/分屏的承载力("会话太多了,急需一个大的画布");且需要一眼看清 leader/worker 关系、跨工作空间协作、会话自由组合。
> 定位:**进攻型差异化**——非对标任何竞品(主流形态均为列表/tab),而是给 CC-Panes 已有的编排引擎(leader/worker、谱系、消息原语)一个空间化的操作面。
> 关联:[docs/44-orchestration-primitives.md](./44-orchestration-primitives.md)(边语义的底层原语)、[docs/46-frontend-styleguide.md](./46-frontend-styleguide.md)(交互约定归口)。

## 1. 核心命题

**分屏是给 4 个会话的,画布是给 40 个的。** 多 agent 并行是赛道确定趋势,现有 UI 范式(tab 隐藏会话、分屏上限 4-6 可见)在 10+ 会话时崩坏。无限画布 + 语义缩放是该问题的自然形态:

- **拉远 = 舰队总览**:每会话一张状态卡(颜色/光晕即状态机状态),空间分区即心智分区
- **拉近 = 单兵操作**:真 xterm,可读可交互
- **空间记忆**:按项目圈地、leader 居中 worker 环绕、完成堆角落——人脑对空间的组织力是列表给不了的

**关键洞察(用户构想的升维):连线即操作,不只是可视化。** 画一条线 = 执行编排原语(注册 worker / 开消息通道),删线 = 解除。画布因此是编排引擎的**操作面**而非视图——44 号文档的原语获得肉身:wait = 等待光圈,消息 = 连线脉冲,协作 = 拖线。

## 2. 对象模型

### 节点(统一抽象 CanvasNode,类型分期落地)

| 类型 | 阶段 | 说明 |
|---|---|---|
| 终端会话节点 | A | 三态渲染:**live**(缩放≈1.0 且视口内,挂真 TerminalView)/ **card**(拉远,状态卡:标题+状态+CurrentActivityBadge+末几行快照)/ **dot**(用户主动缩小,"不要的缩小"——坍缩成状态点,PTY 活着渲染全卸,拖回即恢复;parked 语义的空间表达) |
| 工作空间/项目区域框 | C | 圈地的容器框;**跨工作空间任务在两个框之间连线**表达横跨关系 |
| **能力节点(skill / MCP server)** | C/D | skill 节点(来自 skill 注册表)与 MCP server 节点(来自共享 MCP 服务),被"能力边"连到会话节点(2026-07-24 用户追加:"skills 跟 MCP 也想连就连") |
| 媒体节点(生图/生视频) | D | 后端接自有 sub2api-image-studio / sub2api-video-canvas;出图钉在画布上,数据边喂下游 |
| 便签/标注 | B/C | 轻量,画布自解释用 |

### 边(必须分类型,防"一条线五种意思"歧义)

| 类型 | 谁画 | 视觉 | 语义 |
|---|---|---|---|
| 谱系边 | 系统自动 | 灰虚线 | worktree 父子、fanout 兄弟(数据源:worktree 血缘/任务绑定) |
| 指挥边 | 系统自动 | 实线,worker 上报时脉冲动画 | leader→worker 注册关系(register_plan_worker 即生边) |
| 临时通信边 | **用户拖画** | 高亮实线 | 画线 = 开双向消息通道(依赖 44 号消息原语);可升级固化为指挥边;删线 = 解除 |
| 数据边 | 用户拖画 | 带方向箭头 | 输出→输入(媒体节点用,Phase D) |
| **能力边** | 用户拖画 | 细实线接能力节点 | skill/MCP → 会话的能力接线,三种生效链路:①**未来会话**:边集合在 launch 时编译为该会话的 per-session `mcp-<session>.json` + skill 策略(复用 runtime config 的 mcp_policy/skill_policy 现有字段——连线即可视化 launch 组合器,零新机制)②**运行中会话 + skill**:submit 注入"启用 xxx skill"即刻生效,删边注入解除③**运行中会话 + MCP**:客户端不支持热加 server——保底=边标 pending、"应用并重启"一键(resume 链保上下文);**优解=经 43 号 §7.7 网关 meta-tool**:新 server 注册进网关路由,会话经既有 ccpanes MCP 连接即刻可发现调用,零重启(网关因此成为画布依赖项,一鱼两吃) |

## 3. 关键技术决策

1. **画布 = DOM + CSS transform,不是 `<canvas>`**(tldraw 同路线):终端仍是绝对定位 div 里的 TerminalView 组件原样复用,pan/zoom 是容器 transform。**TerminalView 渲染生命周期红线零接触**——画布只是新的摆放宿主。
2. **live 渲染纪律**:只有缩放 ≈1.0 且在视口内的节点挂真 xterm——同时解决性能(N 个终端只有近处几个活)与非整数倍率的 DOM 文本模糊/IME 定位漂移(干脆不在非 1.0 渲染真终端)。缩放档位吸附(0.25/0.5/1.0)。
3. **选型 spike 二选一**:react-flow(xyflow,MIT——节点/边/小地图白拿,嵌 xterm 有社区先例)vs 手写 transform(几百行零依赖)。**不引 tldraw SDK**(重 + 许可水印条款)。
4. **输入规矩**(落 46 号宪法):Ctrl+滚轮=缩放;空格+拖/中键拖=平移;焦点终端内滚轮=scrollback;Esc=退出终端焦点回画布层。
5. **命名视点(viewpoint)**:保存相机位置+缩放,一键跳转——与 layoutbar 概念同构("布局"升维为"视点"),画布作为 layoutbar 的一种新布局类型与现有分屏**并存**,不替换。
6. 持久化:节点位置/大小/缩小态/视点存工作空间级(workspace.json 或 db),会话与节点以 sessionId 绑定,会话退出节点转墓碑态(可清理)。

## 4. 分期

- **Phase A — spike(2-3 天,验证否决权)**:画布宿主 pan/zoom + 终端节点 live/card 双态 + 缩小态;**Windows WebView2 实机验证**:transform 图层性能(8+ live 终端拖动帧率)、DPI 缩放、IME。选型结论(react-flow vs 手写)回写本节。**验收:8 会话画布拖动不掉帧,1.0 缩放下终端输入/滚动/选择与现分屏无差**
- **Phase B**:三类自动边(谱系/指挥)+ 状态光晕 + 命名视点 + 小地图 + 空白处右键 = P1-8 创建菜单(画布直接 launch 落点)
- **Phase C**:临时通信边(依赖 docs/44 消息原语落地)、区域框与跨工作空间连线、fanout-compare 空间铺开集成
- **Phase D**:媒体节点(sub2api 后端)+ 数据边

## 5. 风险与对冲

- **无限画布变无限垃圾场**:自动布局辅助(按项目分区、worker 环绕 leader、吸附对齐)+ 视点 + 小地图;画布是可选布局类型,不喜欢的用户无感
- **WebView2 性能未知**:Phase A 一票否决制——spike 不达标就降级为"总览画布"(全 card 无 live 终端,点击跳转到常规布局),仍保留舰队总览价值
- **范围蔓延**:媒体节点/数据边严格锁在 Phase D,MVP 是纯终端画布
- 边语义依赖 44 号原语进度:Phase C 前需 send_to_worker/消息原语落地(顺序天然合理)
- 能力边的 MCP 热插拔依赖 43 号 §7.7 网关 meta-tool;网关未落地前 MCP 能力边只支持"launch 时生效 + pending 重启"两态

## 6. 与现有资产的咬合

MiniView = card 态的现成原型;CurrentActivityBadge = 卡片内容;OrchestratorTaskTree = 谱系数据源;layoutbar = 视点宿主;fanout-compare skill = 空间铺开的第一个消费者;44 号原语 = 边语义;sub2api 系项目 = 媒体节点后端。**画布不是新造一个系统,是给既有系统一个空间化的脸。**

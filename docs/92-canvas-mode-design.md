# Canvas Mode 设计方案

## 1. 目标

Canvas Mode 是终端区域内与普通 pane 布局并列的独立通信可视化布局，不是新的终端类型，也不是编排页面的替代品。

核心目标：

- 保留现有 `pane`、`tab`、PTY 和 xterm 的执行模型。
- 把主 CLI / 分 CLI 以响应式、可调整尺寸的终端卡片放在独立 Canvas 空间中。
- 管道只反映真实的 `dispatch`、`message`、`report` 事件。
- 任务摘要和状态标签显示在终端边缘，不遮挡终端内容。
- 编排面板继续负责任务列表、详情和通知；Canvas Mode 只负责实时空间关系和通信反馈。

非目标：

- 不实现可编辑的 Workflow DAG；节点拖拽只改变 Canvas 中的显示位置。
- 不新建一套独立的终端或会话生命周期。
- 不根据终端文本猜测任务关系或消息传输状态。
- 不因为 Worker 处于 `running` 就持续播放粒子。

## 2. 用户模式

显示模式独立于 `appViewMode` 和 `orchestrationOverlayOpen`：

```ts
type CanvasDisplayMode = "panel" | "canvas";
```

- `panel`：显示现有终端面板，Canvas 视图隐藏但普通终端保持挂载，不拦截终端操作。
- `canvas`：普通 pane 布局隐藏并让出主内容区，独立 Canvas 显示可拖拽的终端卡片、管道、粒子、摘要和状态效果。
- 打开编排面板时，编排面板可以覆盖在终端和画布之上；关闭后回到原来的终端/画布状态。

显示状态使用独立的 `useCanvasDisplayStore` 保存，不能复用侧栏的 `appViewMode`。两种模式共享 `TaskBinding`、pane/session 映射和事件数据。

## 3. 渲染结构

主视图在两个同级布局之间切换，普通 pane 不与 Canvas 交叉：

```tsx
<div className="relative h-full w-full">
  <div data-terminal-layout-view>{/* existing PaneContainer */}</div>
  <div data-terminal-canvas-view>{/* independent Canvas */}</div>
</div>
```

画布层内部采用四层职责：

```text
Terminal Layer  Canvas 卡片内复用现有 session 的 attach-only xterm 镜像
Pipe Layer      SVG 路径、方向箭头、管道状态样式
Particle Layer  Canvas 高频粒子动画
Label Layer     HTML 任务摘要、状态标签、可点击交互
```

### 3.1 Terminal Layer

普通模式不改变现有终端布局。Canvas 卡片只复用现有 session 的输出，不创建新 PTY；
普通 pane 继续处理输入、输出、resize、恢复和 session 生命周期。Canvas 镜像使用基于
视口和节点角色计算的初始尺寸、`drivesBackendPty={false}` 和只读视图参数；主 CLI
默认比分 CLI 更大，节点可通过右下角手柄拉伸。

终端叶子补充稳定的几何定位标记：

```tsx
data-flow-session-id={leaf.sessionId}
data-flow-tab-id={tab.id}
data-flow-leaf-id={leaf.id}
```

任务绑定仍通过 `sessionId`、`tabId`、`paneId` 和 `leafId` 解析到真实终端。不能用任务数组下标作为定位身份。

### 3.2 Pipe Layer

使用 SVG 绘制从源节点右侧到目标节点左侧的路径，并使用 `marker-end` 绘制箭头。路径位置
来自 Canvas 节点自己的坐标，不读取普通 pane 的 `getBoundingClientRect()`。

每条路径包含：

- 背景管道：低透明度、稳定显示，用来表达静态的 `parentId` 关系。
- 活动管道：仅在对应通信事件处于 `queued`、`flowing`、`delivered` 或 `failed` 的短生命周期内显示。
- 状态颜色：正常使用 accent，失败使用 danger，成功反馈使用 success。

第一阶段的静态关系直接由 `TaskBinding.parentId` 生成：

```text
leader binding  ->  worker binding
```

以后如果需要任意节点互联，再独立增加 `FlowEdge`，不把复杂关系塞回 `TaskBinding`。

### 3.3 Particle Layer

Canvas 只负责高频粒子，不负责节点文字和路径。粒子的输入是已验证的 pipe event：

- 只对 `flowing` 事件创建移动粒子。
- `running`、`active` 或 `waiting` 等任务状态不能直接触发粒子。
- `reduced` 和 `off` 动画强度必须降低或关闭 requestAnimationFrame。
- 所有动画在组件卸载、模式切换和事件过期时清理。

### 3.4 Label Layer

HTML 标签负责可读文字和交互：

- 任务摘要显示在源端或目标端的终端边缘。
- 标签默认 `pointer-events: none`，只有按钮本身可点击。
- 文本不能覆盖终端主要内容区；超出边缘时向内翻转或裁剪。
- 点击摘要可以定位到对应 layout、pane、tab、terminal leaf，并切换回 `panel` 方便查看终端。
- 长摘要使用截断，完整内容放在 `title`/tooltip，不把整段消息铺在终端上。

## 4. 几何与响应式

`PaneFlowOverlay`（实现上是独立 Canvas 视图）使用 Canvas 坐标维护节点位置：

1. 首次按 `TaskBinding.parentId` 将主 CLI 放在左列、子 CLI 放在右列。
2. 初始尺寸根据视口、主从角色和节点数量动态计算，Canvas 空间按节点边界扩展并提供滚动。
3. 标题栏拖拽只更新 `x/y`，右下角手柄只更新 `width/height`，不改变普通 pane 的 split 尺寸、tab 顺序或 PTY 生命周期。
4. 使用 `ResizeObserver` 监听 Canvas 视口变化，保留用户位置并重新计算可滚动范围。
5. 节点集合变化时只为新节点生成默认位置，已有节点继续使用快照位置。

几何数据只保存节点位置快照，不能保存 DOM 引用。快照作用域为：

```ts
{ workspaceId, layoutId }
```

拖拽位置快照按普通布局隔离，作用域为 `{ workspaceId, layoutId }`；切换“布局 1 / 布局 2”
时只加载当前布局的 Canvas 节点、管道和位置快照。

## 5. 数据模型

### 5.1 节点

节点由当前布局中的活动 `TaskBinding` 和终端叶子投影生成。失败、已完成或没有活动
session 的历史记录保留在编排数据中，但不进入 Canvas：

```ts
interface CanvasNodeProjection {
  id: string;
  label: string;
  kind: "task" | "terminal";
  bindingId?: string;
  sessionId?: string;
  paneId?: string;
  tabId?: string;
  leafId?: string;
  layoutId?: string;
  parentId?: string;
  status: "pending" | "running" | "waiting" | "completed" | "failed" | "idle" | "offline";
  progress?: number;
  position?: CanvasNodePosition;
}
```

任务节点优先于普通终端节点。一个已经被 binding 表示的终端叶子不再生成第二个独立 terminal 节点，避免同一 session 在画布中重复出现。
只有 `running` binding 和当前布局中仍有活动 session 的未绑定终端会显示。

### 5.2 管道事件

事件是后端发送的轻量视觉旁路，前端只消费事件，不解析终端文本：

```ts
interface PipeEventWire {
  schemaVersion: number;
  eventId: string;
  correlationId: string;
  attempt?: number;
  sequence: number;
  workspaceId: string;
  kind: "dispatch" | "message" | "report";
  phase: "queued" | "flowing" | "delivered" | "failed";
  fromBinding?: string;
  toBinding?: string;
  fromSession?: string;
  toSession?: string;
  summary: string;
  reason?: string;
  createdAt: string;
}
```

`idle` 是没有活动事件时的隐式状态，不需要后端发送 idle 事件。旧版本只发送 `queued`、`delivered`、`failed` 时，前端可以把 `queued` 短暂过渡到 `flowing`，但新实现应在真实投递开始时发送 `flowing`，避免动画时间与业务动作脱节。

事件 reducer 要按 `correlationId + attempt + kind + direction` 合并生命周期，并按 `sequence` 忽略旧事件。事件过期只清理视觉记录，不能影响 TaskBinding 或终端 session。

## 6. 状态机与视觉反馈

### 6.1 管道状态

```text
idle -> queued -> flowing -> delivered
                  └-------> failed
```

具体效果：

| 状态 | 触发条件 | 视觉效果 | 生命周期 |
| --- | --- | --- | --- |
| `idle` | 没有活动事件 | 静态低透明度管道 | 持续 |
| `queued` | 事件进入队列 | 源端短暂脉冲，管道可提高亮度 | 约 180-300ms |
| `flowing` | 真实 dispatch/message/report 开始传输 | 粒子从源端沿 SVG 路径移动到目标端 | 直到 delivered/failed |
| `delivered` | 目标端收到事件 | 目标端扩散光，管道短暂变亮 | 约 450-700ms |
| `failed` | 投递或目标 session 失败 | 粒子在中途停止并变红，路径红色闪烁 | 约 500-800ms |

### 6.2 节点状态

节点状态来自 TaskBinding/session 状态，不由粒子事件推导：

| 状态 | 视觉效果 |
| --- | --- |
| `waiting` | 目标终端边框黄色呼吸；不持续发送粒子 |
| `completed` | 节点边框绿色闪烁一次，然后回到稳定成功色 |
| `failed` | 节点边框和状态点使用 danger 色 |
| `running` | 节点保持运行态，不自动播放通信动画 |
| `offline` | 节点降低透明度并显示离线色 |

`waiting` 和 `completed` 的效果需要记录状态变化边沿。不能因为 React 每次收到相同 binding 快照就重复触发闪烁。

## 7. 后端事件接入

保留现有 `TaskBinding` 状态事件，再通过 `PipeEventService` 发出视觉事件。建议接入点：

### `dispatch_task`

```text
创建 child binding       -> queued
开始启动/发送首条任务     -> flowing
session 创建并投递成功    -> delivered
启动、持久化或投递失败    -> failed
```

### `send_to_worker` / directive queue

```text
目标 worker 忙或不可写     -> queued
真正写入 worker session    -> flowing
写入成功                  -> delivered
写入失败、session error    -> failed
```

### `report_to_leader`

```text
报告准备投递              -> queued
开始向 leader 写入         -> flowing
leader 收到报告            -> delivered
dsh/session 不存在或写入失败 -> failed
```

事件发射失败只能记录 warning，不能让业务派发或报告调用失败。前端收到未知 phase、未知 kind、坏时间或旧 schema 时直接丢弃并记录可诊断日志。

如果协议从当前 phase 集合扩展到 `flowing`，Rust enum、TypeScript adapter、测试 fixture 和 schema 版本策略必须同步更新。对旧客户端可继续把未知 `flowing` 降级为不显示粒子，但不能把它误判为任务 `running`。

## 8. 前端模块边界

建议保持以下职责分离：

| 模块 | 责任 |
| --- | --- |
| `useCanvasDisplayStore` | `panel/canvas`、动画强度 |
| `useCanvasStore` | 节点快照、pipe events、事件生命周期 |
| `canvasProjection.ts` | TaskBinding/terminal 到节点和静态边的纯函数投影 |
| `defaultCanvasPositions` | 主 CLI / 子 CLI 的响应式默认布局 |
| `PipeSvgLayer` | SVG 静态管道、箭头、状态样式 |
| `ParticleCanvasLayer` | flowing 粒子和短时粒子效果 |
| `CanvasNodeLayer` | 响应式终端卡片、拖拽、拉伸、摘要和节点点击 |
| `PaneFlowOverlay` | 独立 Canvas 视图，组合四层、控制显示、绑定生命周期 |
| `pipeEventAdapter.ts` | IPC/Web event 校验和转换 |
| `pipeEventReducer.ts` | 去重、顺序、生命周期和过期 |

`MainViewSwitcher` 只负责在普通 pane 布局和独立 Canvas 视图之间切换；Canvas 不挂在编排列表面板内，也不覆盖普通终端。

## 9. 性能与降级

- Canvas 视口变化由 `ResizeObserver` 处理；自动布局随视口变化，只有用户拖拽或拉伸过的节点写入位置快照。
- SVG 只绘制路径和低频状态，Canvas 才承载粒子。
- 无 `flowing` 事件时不启动全局动画帧。
- `reduced` 使用低频定时器或更少粒子，`off` 只保留静态路径和状态颜色。
- 管道数量异常增大时按当前 workspace 的节点集合裁剪，不能为不存在的节点创建动画。
- Web/非 Tauri 环境保留 no-op listener，使用 fixture 也能验证渲染。
- 页面切换、Canvas 隐藏和视图卸载必须取消 ResizeObserver、RAF、timeout 和粒子状态。

## 10. 实施阶段

### 阶段一：几何和静态关系

1. 保留现有终端渲染，补充 `data-flow-session-id`、`data-flow-tab-id`、`data-flow-leaf-id`。
2. 完成 `TaskBinding.parentId` 到节点和静态 SVG 箭头的投影。
3. 接入 Canvas 视口 `ResizeObserver`、节点拖拽和尺寸快照。
4. 增加 Canvas Mode 开关，确认 panel 模式不拦截终端输入且 Canvas 模式不显示默认 pane。

### 阶段二：事件链路

1. 固化 pipe event schema 和 adapter 校验。
2. reducer 支持去重、sequence、attempt、scope 和 TTL。
3. 在 dispatch、message、report 真实路径发出 `queued/flowing/delivered/failed`。
4. 用真实事件替换假事件 fixture；假事件只留在开发测试工具中。

### 阶段三：视觉反馈

1. queued 源端脉冲。
2. flowing 粒子沿真实路径运动。
3. delivered 目标端扩散光。
4. failed 中断粒子和红色反馈。
5. waiting 黄色呼吸边框、completed 绿色单次闪烁。
6. 接入动画强度和减少动态效果设置。

### 阶段四：交互和收尾

1. 任务摘要边缘定位、碰撞/翻转和 tooltip。
2. 点击节点定位到真实 terminal，并提供回到 panel 的路径。
3. 按 workspace/layout 保存画布显示和必要的节点位置。
4. 完成桌面宽屏、窄窗口、隐藏布局和无 binding 终端的视觉检查。

## 11. 测试与验收

### 纯函数和协议

- TaskBinding parent/child 投影和边去重。
- terminal leaf 无 binding 时生成独立节点。
- adapter 接受 `queued/flowing/delivered/failed`，拒绝未知 phase、schema 和非法时间。
- reducer 保留最新 sequence，正确处理 retry attempt 和 TTL。

### 组件行为

- panel 模式不绘制 SVG、Canvas 粒子或遮挡层。
- canvas 模式显示可调整尺寸的终端卡片，普通 pane 被隐藏但 xterm/PTY 生命周期不改变。
- queued 只触发源端脉冲；没有 flowing 事件时不启动持续粒子。
- flowing 只创建有限粒子；delivered/failed 只产生一次性反馈。
- waiting 不发送粒子，completed 不因重复快照重复闪烁。
- 点击摘要能定位到对应 terminal，长摘要不会遮挡终端正文。

### 集成验证

- 拖动 Canvas 节点后管道端点跟随，普通 pane 分屏结构不改变。
- layout 切换后不串用旧布局或 workspace 的 Canvas 节点、位置和事件。
- 编排 overlay 打开/关闭不改变 Canvas Mode 状态。
- Tauri IPC 事件和 Web no-op listener 都能正常工作。
- TypeScript、前端全量测试、Rust core 事件序列化测试和 Windows Debug 构建通过。

## 12. 验收标准

完成后，用户应该能看到：

1. 普通模式仍是真实可操作的 xterm/PTY；Canvas 模式显示响应式终端镜像和关系反馈。
2. 主 CLI 与分 CLI 的静态关系来自 `TaskBinding.parentId`，不是截图式或手工写死的布局。
3. 只有真实 dispatch/message/report 事件才会产生粒子；Worker 单纯 running 不会持续发光。
4. queued、flowing、delivered、failed、waiting、completed 的视觉效果可区分且可结束。
5. 节点拖动、窗口 resize、布局切换后，管道仍对准 Canvas 中对应的终端卡片。
6. 编排列表和详情面板继续独立工作，Canvas Mode 不改变现有任务和终端生命周期。

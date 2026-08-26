# Canvas 媒体生成技术方案

## 结论

图片和视频都直接呈现在现有终端区域 Canvas 的 `media` 节点中。节点主体使用 DOM `img` 和原生 `video`，而 SVG/Canvas 图层只负责节点之间的连线、箭头和粒子动画。这样可以保留浏览器原生的视频解码、暂停、音量和无障碍能力，也不会为每一帧复制像素。

媒体节点与终端节点共享拖拽、缩放、快照和事件状态；媒体内容不会挂载 `TerminalView`，也不会改变现有 `orchestration-pipe-event` v1 协议。

## 分层

```text
Canvas UI / MCP
      |
MediaFacade (统一鉴权、幂等、权限和事件)
      |
MediaJobService + ProviderAdapterRegistry
      |
cc-panes-core models/repository  -> SQLite v37
      |
media/<workspace>/<asset-id>.<ext>
```

- `MediaNode` 描述画布上的生成节点；`MediaRun` 描述一次独立运行，因此同一节点可以反复生成并保留历史。
- `MediaAsset` 只保存受控相对路径、MIME、大小、哈希和媒体尺寸；文件位于应用数据目录下，沿用壁纸文件的路径和符号链接校验。
- Provider 通过能力注册表声明支持的操作、输入端口和输出类型。sub2api 使用独立媒体配置，通用 Provider 复用现有 Provider 配置，但不假设所有服务使用同一种 API 协议。

## 任务状态

```text
queued -> submitting -> processing -> downloading -> succeeded
             |              |             |
             +------------ failed / canceling -> canceled
```

服务层负责 lease、重启恢复、超时、重试和 `clientRequestId` 幂等。下游节点默认由用户显式运行，不自动串联；第一版数据边只允许媒体节点间的强类型端口连接。

## Canvas 投影

- `CanvasNodeProjection.kind` 增加 `media`，携带当前运行状态、预览资产、媒体类型和操作能力。
- Canvas snapshot 升为 v2。快照只保存位置、尺寸和视图设置；节点、运行记录、资产和边以 SQLite 为事实来源，并兼容 v1 快照。
- 新增独立 `media-job-changed` 事件。Tauri 使用事件监听，Web 使用认证 WebSocket，并保留轮询作为断线兜底；原有终端管道事件继续按 v1 消费。
- 图片节点渲染 `<img loading="lazy">`；视频节点渲染 `<video controls preload="metadata" playsInline>`，默认不自动播放。大图/长视频只在节点可见时加载，节点移出视口后释放媒体资源。

## 入口和安全

桌面 Tauri commands、Web REST/WebSocket 和 MCP 工具都调用同一个 `MediaFacade`，避免三套状态机。所有请求校验工作区、节点、端口、输入资产和大小上限；下载只允许 HTTPS/配置的 Provider 域名，资产 URL 不直接信任用户输入。文件下载完成后先写临时文件、校验 MIME/大小/哈希，再原子移动到媒体目录。

## 分阶段交付

1. Core 模型、v37 迁移、资产路径和运行状态机。
2. Canvas `media` 节点、图片/视频预览、节点位置快照和运行历史。
3. Provider 适配器注册表与 sub2api/通用 Provider 配置。
4. Tauri/Web/MCP 统一入口、事件推送、取消/重试和恢复。
5. 执行指纹、局部缓存、队列优先级和 runtime 资源调度（基础版已完成，真实 GPU 调度待端到端验证）。
6. 多参考图、批量、编辑、放大、视频续写及端到端测试。
7. 工作流模板、版本差异、受信 custom node 能力和跨版本兼容（模板/版本差异基础版已交付，custom node 信任策略与跨版本迁移待后续）。

## ComfyUI 借鉴矩阵

这里借鉴的是 ComfyUI 已验证的边界和交互模型，不复制它的前端或推理实现：

| ComfyUI 能力 | 提取的设计 | CC-Panes 落点 | 状态 |
| --- | --- | --- | --- |
| API 工作流图（`POST /prompt`） | 用 `node_id -> { class_type, inputs }` 表达可复现、有向无环的工作流 | `ComfyWorkflow` 校验器和 ComfyUI Provider；拒绝 UI blueprint，保留原始 API JSON | 已落地 |
| WebSocket 执行事件（`/ws?clientId=`） | 事件驱动进度，避免高频轮询；节点级进度可映射到运行记录 | `ComfyEventStream`、按 `prompt_id` 路由、单调进度更新并广播 `media-job-changed`；断线回退历史轮询 | 已落地（桌面/Web worker） |
| 历史与输出（`/history/{prompt_id}`、`/view`） | 历史是最终事实来源，输出通过受控文件接口下载 | `ComfyMediaAdapter` 轮询、MIME/大小/SHA-256 校验、原子归档 | 已落地 |
| 节点能力发现（`/object_info`） | 由服务端声明节点输入、输出和类型，前端按能力生成表单 | Tauri/Web 统一 schema facade、按 Provider 复用 adapter 缓存、60 秒 schema 缓存、SHA-256 指纹和按节点查询接口 | 已落地 |
| 输入资产（`/upload/image`） | 参考图先上传并返回服务端文件引用，工作流只传引用 | 受限 multipart 上传、路径校验、`inputBindings` 与 `{{input:n}}` 占位符；workflow 不写本地绝对路径 | 基础接口已落地 |
| 队列与中断（`/queue`、`/interrupt`） | 统一查看排队/执行任务，取消操作与具体 prompt 关联 | `MediaJobWorker` 的 lease、取消、重试和重启恢复 | 基础能力已落地，需补真实引擎端到端 |
| 本地运行时 | Python 引擎与应用生命周期分离，回环地址和隔离目录 | Tauri `ComfyRuntimeService`、`ProcessGuard`、随机端口、独立 output/temp | 代码已落地，待 Windows 实机 |
| 资源状态与显存释放（`/system_stats`、`/free`） | 读取 RAM/VRAM、设备和版本信息；推理前后按需释放模型/缓存 | `ComfySystemStats` 白名单投影、Tauri/Web 统一 adapter、Provider 面板刷新/释放/卸载操作 | 已落地（基础版，真实 GPU 仍待实机） |
| 局部执行（`partial_execution_targets`） | 只执行选中的输出节点，让 ComfyUI 缓存复用未受影响的上游 | Comfy workflow 编辑器提供输出节点选择；adapter 校验节点 ID 后提交局部目标 | 已落地（基础版） |
| 工作流模板与版本差异 | 保存可复用 API workflow，保留版本并比较节点/Schema 变化 | provider-scoped Zustand 持久化模板、20 个版本上限、API/UI 格式校验、加载与结构差异对话框 | 已落地（基础版） |

## 不直接提取的部分

- 不复制 ComfyUI 的 LiteGraph/React 前端；CC-Panes 继续使用现有 Canvas、Allotment 和媒体节点。
- 不把 Python 推理、模型权重、custom nodes 或 CUDA/显存管理移植到 Rust/TypeScript；这些由 ComfyUI 进程负责。
- 不把 ComfyUI 的文件路径直接暴露给 Web 客户端；所有输出经过 `MediaAsset` 归档和权限校验。
- 不强制所有 Provider 采用 ComfyUI 协议；OpenAI-compatible、sub2api 和 ComfyUI 保持独立适配器。

## 源码中值得提取的机制

这次提取的是 ComfyUI 的稳定机制和边界，而不是照搬界面。参考依据如下：

| ComfyUI 源码/文档 | 可复用机制 | CC-Panes 的改造方式 |
| --- | --- | --- |
| `README.md` 的能力说明 | 可复用子图、模板、App Mode、异步队列、局部重算、VRAM/RAM 管理、模型卸载、工作流随输出保存 | 把复杂工作流封装成可复用模板；在 Canvas 中只暴露必要参数；把执行缓存和资源调度放进 Provider runtime |
| `execution.py`、`comfy_execution/graph.py` | 依赖图拓扑执行、输入变化检测、只执行目标输出、输出节点优先、失败节点上下文 | 增加 workflow fingerprint、受影响分支计算和“仅重跑下游”操作；运行记录保存节点级错误上下文 |
| `comfy_execution/caching.py` | 按输入签名缓存、LRU/内存压力淘汰、缓存 provider | 在 CC-Panes 建立本地输出缓存索引；缓存命中直接复用不可变 `MediaAsset`，不重复推理；显存缓存仍由 ComfyUI 管理 |
| `server.py` 的 `/ws`、`/queue`、`/history`、`/interrupt`、`/free` | 事件流、队列优先级、中断、历史最终事实源、释放模型/内存 | 统一 `MediaJobEvent`（带序号和 `runId`），断线可重放；按 Provider/GPU 限制并发；取消和释放操作可追踪 |
| `server.py` 的 `/object_info`、`nodes.py` custom-node loader | 节点 schema 能力发现、V1/V3 节点扩展、搜索别名和输入约束 | 缓存带版本和指纹的 schema；未知节点保留 raw JSON；custom node 只允许受信任 runtime 配置，不在 Web 端自动安装代码 |
| `comfy_extras/nodes_video.py`、`comfy_api/latest/_input/video_types.py` | 视频是带帧率、时长、音频、色彩空间和编码器的媒体对象，可拆帧/裁剪/合成 | `MediaAsset.metadata` 增加 fps、frameCount、codec、audio、colorSpace、poster；视频节点支持首尾帧、裁剪、续写和音频封装 |

### 两层图模型

不要把 Canvas 图和 ComfyUI prompt 图混成一张表：

1. **CanvasGraph**：面向用户的媒体节点、位置、端口、历史资产和跨 Provider 连接，继续由 CC-Panes SQLite 管理。
2. **ProviderWorkflow**：面向某个 Provider 的可执行 API JSON，包含 `class_type`、输入链接、模型节点和版本指纹，作为 `MediaRun.request` 的不可变快照。

Canvas 节点可以引用一个 workflow 模板并覆盖白名单参数；提交前再将输入资产、seed 和 Provider 配置注入 ProviderWorkflow。这样同一张 Canvas 可以切换 OpenAI-compatible、sub2api 和 ComfyUI，而不会把 ComfyUI 的节点类型泄漏到通用模型。

### 统一执行指纹与缓存

建议把以下内容规范化后计算 `executionFingerprint`：

```text
provider_id + provider_capability_version + model/runtime fingerprint
+ canonical provider workflow + normalized input asset sha256
+ seed/batch/quality parameters
```

缓存索引只指向已校验的不可变 `MediaAsset`，并记录命中来源、创建时间和失效原因。修改 prompt、seed、参考素材、模型版本或 schema 指纹时必须失效；只改变下游参数时只重跑受影响分支。缓存不能绕过权限、工作区归属或 MIME/大小校验。

### 调度与资源策略

- 每个本地 ComfyUI runtime 维护一个 worker lease；同一 GPU 默认串行，远程 Provider 按配置并发。
- 队列项包含 `priority`、预计显存/时长、取消令牌和幂等键；高优先级只能插队等待项，不能抢占正在执行的推理。
- readiness 读取 `/system_stats`；显存不足时先给出可操作提示，再按策略调用 `/free`，不在 CC-Panes 猜测模型是否能加载。
- worker 重启后以 `/history/{prompt_id}` 对账，事件只负责实时体验；不会因为 websocket 重连重复提交。

### 媒体产品切片

**生图**：先做 text-to-image、image-to-image、inpaint/mask、批量 seed、变体和放大；随后接入 ControlNet/IP-Adapter/LoRA 等由 schema 声明的可选分支。每张输出保留 prompt、负面 prompt、seed、采样器、模型、LoRA、尺寸和 workflow fingerprint，可从图片重新恢复参数。

**生视频**：先做 image-to-video 和 text-to-video，再做首帧/尾帧、时长/帧率、裁剪和续写。输出采用“视频文件 + poster + 可选音轨/波形 + 帧级元数据”的资产组；下载使用 Range/临时文件/断点续传，浏览器只加载 poster 和 metadata，用户播放或导出时才拉取完整文件。音频、色彩空间和编码器能力必须来自 Provider schema，不能写死在通用表单。归档前可用受控 `ffprobe` 对实际容器做二次确认：成功时以流/封装信息覆盖声明值，失败时保留 Provider 值并写入 `probeStatus`，不会把“探测器不存在”误记为“无音轨”。

## 方案验收指标

- **可复现**：同一 workflow、模型/runtime、输入哈希和 seed 生成相同 `executionFingerprint`；历史可一键复制为新 run。
- **高效**：只改下游参数时，上游命中缓存且不重复推理；批量任务不会阻塞 Canvas 主线程。
- **可恢复**：断开 websocket、重启 CC-Panes 或 ComfyUI 后，任务最终状态和已下载资产不丢失，不产生重复资产。
- **可诊断**：错误显示 provider、节点、输入字段、可重试性和建议动作；不把 Python traceback 直接暴露给远程未授权用户。
- **视频完整性**：播放前能读到 MIME、宽高、fps、时长和音频存在性；Range 请求、取消下载和临时文件清理均有测试。
- **兼容性**：API workflow 与 UI blueprint 明确区分；schema 指纹变化会提示复核；未知 custom node 可原样保存但不会被静默执行。

## 实施路线与验收

### P0：协议和任务底座（当前已完成）

完成 MediaNode/MediaRun/MediaAsset、SQLite 迁移、Provider 注册、API workflow 校验、提交/历史/下载合约、图片/视频 Canvas 预览、Tauri 本地运行时和 Web REST/WS 入口。验收以 TypeScript、Rust 检查、ComfyUI 专项单元测试和 HTTP 合约测试全部通过为准。

### P1：实时执行与运行时可靠性（基础版已落地）

1. 为每个 ComfyUI Provider 建立带 `clientId` 的 `/ws` 连接，按 `prompt_id` 路由 `status`、`executing`、`progress`、`progress_state`、`executed` 和错误事件。
2. `/history` 继续作为最终状态源；WebSocket 断线、服务重启或事件缺失时自动回退轮询。
3. 启动后探测 `/system_stats` readiness，捕获受限 stderr 摘要，区分“进程已启动”和“HTTP 可用”；停止、重启和异常退出都回收进程树。

验收：进度在 1 秒内可见，断开 WebSocket 后任务最终状态不丢失，取消和重启恢复不产生重复资产。当前已完成协议、状态机和 worker 单元/合约测试；真实模型执行仍需 Windows + ComfyUI Python 环境验证。

### P1.5：执行效率与资源调度（基础版已完成）

1. 已为每个 run 计算 `executionFingerprint`，将规范化请求、Provider/模型、非密钥 Provider 配置摘要和输入资产内容哈希纳入索引；`cachePolicy` 控制是否读取/写入，不改变执行内容指纹。Tauri、Web 与 MCP 提交入口使用同一摘要，覆盖规范化端点、协议和提交/状态/取消路径，不包含 API Key，也不会写入 `MediaRun.request`；端点或协议变更不会命中旧缓存。Comfy workflow/schema 指纹在请求显式提供时也会参与指纹。命中时复用已校验的不可变资产，并为新 run 建立 output 关联。
2. 已对 worker 增加优先级队列、批量 claim、并发上限、lease 和取消/重试状态；运行中任务不被插队抢占，等待中的任务可调整顺序，claim 或处理失败都会释放并发槽。
3. 已记录缓存命中标记和资源快照，并接入 ComfyUI `/system_stats` 与 `/free`：前端可查看 Provider 的 RAM/VRAM 和设备版本，并明确请求释放缓存或卸载模型；真实显存压力和模型卸载策略仍由 ComfyUI runtime 负责。

验收：相同指纹命中已有资产且不产生第二次远端任务；缓存文件被删除或哈希不匹配时自动失效；worker 重启后能对账历史并清理过期 lease。仅修改下游参数时的分支级重算仍列入 P3。

### P2：能力发现与参考图绑定（基础接口已落地）

1. 缓存 `/object_info`，按节点类、输入类型、输出类型和 ComfyUI 的搜索元数据生成可搜索的节点/参数面板；编辑器会识别 LoRA、ControlNet、IP-Adapter 语义分支并显示当前/可用节点计数，未知 custom node 仍可通过原始 JSON 使用。
2. 实现 `/upload/image` 适配，先把输入写入受控暂存区，再上传到 ComfyUI；workflow 只保存服务端引用和绑定关系。动态参数面板支持多参考素材按索引绑定、切换和解绑。
3. 已对 workflow 做版本化、校验和差异显示，区分 UI 格式与 API 格式，避免用户粘贴错误格式后才在远端失败；模板按 Provider 隔离，保存相同内容不会重复生成版本。

验收：参考图不会泄露绝对路径；同一 workflow 可在本地和远程 ComfyUI 重放。动态节点参数面板按 `/object_info` 生成枚举、数值、布尔和文本控件；未知 custom node 保留原始 JSON 编辑；schema 指纹变化会提示复核，API workflow 带版本和 canonical SHA-256 指纹。模板保存/加载、版本历史和节点结构差异已覆盖前端专项测试。

### P3：生图/生视频产品化（基础切片已落地）

- 生图：批量 seed、变体、重绘/局部重绘、放大和输出预览图；输出携带可恢复的 prompt/seed/模型/工作流元数据。
- 生视频：首帧/尾帧、图生视频、续写、帧率/时长/音频能力按 Provider schema 显示；视频采用 poster、流式下载和断点可恢复文件。
- 视频归档：`MediaProbe` 只对受控暂存文件调用固定参数的 `ffprobe`，设有进程超时、输出上限和 Windows 隐藏窗口；默认从 PATH 查找，也可用 `CCPANES_FFPROBE` 指定受控绝对路径；`probeStatus`（`ok`、`unavailable`、`timeout`、`output_limit`、`failed`、`invalid`、`skipped`）随资产保存，声明值与实测值冲突时写入 `probeConflicts`。
- 画布：节点输入/输出端口强类型连接，显式运行下游节点；提供队列优先级、重试、复制参数和历史版本回放。ComfyUI 工作流可选择 `partial_execution_targets`，只重跑选中的输出分支。

本轮基础切片已经覆盖：批量/固定/递增 seed、负面提示词、采样步数/CFG/采样器/denoise、首尾帧与续写参数、视频 poster/Range 读取、历史复制变体、ComfyUI schema 动态控件、局部输出目标和 mask/inpaint 基础链路（遮罩角色校验、暂存和常见 mask 输入自动绑定）。本轮继续补齐了 ControlNet/IP-Adapter/LoRA 的 schema 分支发现、筛选和参数编辑入口，以及 OpenAI-compatible/Sub2API/ComfyUI 的能力差异展示（Web REST、Tauri command、前端表单同一份能力契约）。新增受控视频探测边界：对生成输出和用户暂存视频记录容器、fps、帧数、时长、视频/音频编码、采样率、色彩空间、色彩传递/原色、像素格式和位深、音轨存在性；探测不可用、超时、输出超限或 JSON 无效时显式降级并保留声明元数据。新增 ComfyUI 运行时资源面板：通过白名单解析 `/system_stats`，展示 RAM/VRAM 和设备版本，并通过受控 `/free` 请求释放缓存或卸载模型。仍需 Windows + ComfyUI 实机的真实模型端到端验证；分支节点的自动插入/连线保留为后续图编辑能力，不在当前 JSON 编辑器中猜测拓扑。

验收：图片和视频都能从历史重新打开、下载、复制为新节点；大文件不会阻塞 UI，失败任务能显示可操作的错误原因；视频资产在探测器可用时展示实测音轨/编码元数据，在探测器不可用时明确显示降级状态。

### P4：跨平台发布

桌面端负责本地 ComfyUI 进程；Web daemon 只连接用户明确配置的外部 HTTPS ComfyUI，不尝试在服务器隐式启动 GPU 引擎。补充 Windows GPU/CPU、进程回收、模型加载、图片和视频端到端测试，再进入打包发布门槛。

## 风险和控制

- **模型/显存差异**：能力和资源状态来自 ComfyUI，不在 CC-Panes 中猜测；readiness 失败时给出可诊断日志。
- **路径与内容安全**：只允许回环 HTTP 或 HTTPS；限制 workflow、JSON 和输出大小；下载前校验 MIME、扩展名和哈希。
- **协议演进**：保留未知 WebSocket 事件，记录 schema 版本；最终状态始终以 `/history` 为准。
- **长任务体验**：任务状态持久化、lease 和幂等键必须先于批量/自动串联，避免重复推理和重复计费。

## 当前验证记录

- `npx tsc --noEmit`、`npm run build`、`git diff --check`：通过。
- `npm run test:run -- --reporter=dot`：466 个测试文件、4556 个测试中 4555 个通过；唯一失败是已有 `TerminalView` 几何时序用例（并发运行时 79×23/80×24 抖动），单独重跑该用例通过；输出中的其余信息为既有 React/Dialog/HTML 结构警告。
- 媒体前端专项（Comfy workflow、媒体表单、节点、服务、store、类型、Canvas 投影）：10 个文件、51 个测试通过。
- `cargo test -p cc-panes-core --lib`：1371 项通过、1 项忽略；媒体 Provider、遮罩绑定和运行时专项测试通过。
- 媒体核心专项过滤测试：44 项通过；Tauri Comfy runtime 过滤测试：3 项通过。
- `cargo test -p cc-panes-web`：113 项通过；媒体 capability、Range 和 WebSocket 合约测试通过。
- `cargo test -p cc-panes --lib`：375 项通过；本地 ComfyUI runtime readiness 测试通过。
- `cargo fmt --all -- --check`、`cargo check -p cc-panes-core`、`cargo check -p cc-panes-web`、`cargo check -p cc-panes`、`cargo clippy -p cc-panes-core -p cc-panes-web -p cc-panes -- -D warnings`：通过。
- 本轮新增验证：ComfyUI adapter 资源端点专项通过；Web `comfy_resource_routes_proxy_stats_and_memory_release` 通过；前端资源/模板/编辑器/服务定向测试 14 项通过；生产构建通过（仅保留既有 CSS、chunk 和循环依赖提示）。
- `cargo test --workspace` 已在当前 Windows 环境启动并通过此前目标，但在 `start_runner_integration` 的首个 PTY 集成用例停止：Win32 `CreateProcessW` 找不到测试 shell 的 `pwsh`（`src-tauri/tests/start_runner_integration.rs:147`）。这不是媒体断言失败；需在具备系统 PowerShell 7 PATH 的主机/CI 环境复跑该集成目标后，才能宣称 workspace 全绿。
- 尚未宣称真实图片/视频模型端到端通过：当前环境没有可用的 ComfyUI Python 依赖、模型和 GPU/CPU 运行验证条件。Windows 实机验收必须使用 ComfyUI 的 `/system_stats`、`/object_info`、`/prompt`、`/history` 和 `/ws` 五条链路，并分别覆盖图片输出、视频输出、断线恢复和取消。

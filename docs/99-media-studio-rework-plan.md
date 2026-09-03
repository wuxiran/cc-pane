# 媒体生成工作台整改计划

对照 `docs/22-media-generation-canvas-plan.md` 与当前代码（`web/components/media/*`、`cc-panes-core/src/services/media_*.rs`、`comfy*.rs`、`src-tauri/src/lib.rs` 媒体 worker 段）做的一次现状盘点。docs/22 里大量"已落地"指的是"代码存在且单测通过"，不是"用户能在界面上用、且对真实 Provider 跑通"。这两件事的差距就是当前"问题太多"的根源。

## 一句话结论

媒体功能是 2026-08-27 一次 24k 行提交（`98725608`）整体落地的，后端做了非常重的通用底座（状态机、lease、指纹缓存、ComfyUI 全链路、ffprobe），但**从未对任何真实 Provider 端到端跑通**，前端只暴露了底座的一小部分，而且 Provider 配置直接混进了 LLM Provider 表。整改的顺序应该反过来：先砍范围、让一条链路对真实 API 跑通，再决定画布和 ComfyUI 要留多少。

## 问题清单

按"是否阻塞真实使用"排序。每条都给出代码位置，方便直接开工。

### A. 协议层：对真实 Provider 基本跑不通（阻塞）

| # | 问题 | 位置 |
| --- | --- | --- |
| A1 | OpenAI 兼容适配器把前端表单的所有参数**原样塞进请求体**：`steps`、`cfgScale`、`sampler`、`seedMode`、`variantSeeds`、`batchSize`、`aspectRatio`、`frameMode`、`codec`、`colorSpace`、`frameCount`、`resolution`、`negativePrompt`、`maskInputIndex`……运行时只剥掉了 `providerProtocol`/`mediaScope` 这类路由键。OpenAI 官方和多数中转对未知字段直接 400。 | `media_runtime.rs:491-528`、`media_provider.rs:384-439` |
| A2 | 图生图/编辑把参考图编码成 `input: [{data, mimeType, role}]` JSON 数组；OpenAI `/images/edits` 要求 multipart `image[]`/`mask`。视频默认路径 `/videos/generations` + 轮询 `/jobs/{id}` 不对应任何真实 API（OpenAI 是 `POST /videos` → `GET /videos/{id}` → `GET /videos/{id}/content`）。 | `media_provider.rs:23-25`、`to_wire_body` |
| A3 | 输出下载的 host 白名单默认只有 base URL 的 host。OpenAI 返回的是 Azure Blob CDN 地址，中转多半也是第三方对象存储，会被 `MEDIA_PROVIDER_URL_REJECTED` 拒掉。只有 `b64_json` 能走通，但请求没有强制 `response_format`。 | `media_provider.rs:147`、`is_allowed_host` |
| A4 | 能力声明是编的：任何 OpenAI 兼容 Provider 都宣称支持全部 7 种操作 + 视频 + 异步。前端按这个能力表渲染操作按钮，于是用户看到"视频续写"按钮，点了才失败。 | `media_provider.rs:1095-1112` |
| A5 | `sub2api` 协议和 `open_ai_compatible` 在代码里完全等价，只是一个标签。 | `media_provider.rs:733,758` |
| A6 | 远程 ComfyUI 适配器构造时丢掉了 API key，带鉴权反代的 ComfyUI 连不上；本地 ComfyUI 运行时（`comfy_runtime.rs`、`ComfyResourcePanel`、start/stop/restart 命令）在 UI 上没有任何入口，`comfy-local` 哨兵已被前端主动迁走。 | `media_runtime.rs:306-316`、`MediaProviderSection.tsx:34,78-86` |

### B. Provider 配置与 LLM Provider 混用（会破坏其他功能）

| # | 问题 | 位置 |
| --- | --- | --- |
| B1 | 媒体 Provider 保存到共享的 `useProvidersStore`，`providerType: "open_ai"`，于是出现在 Agent Chat、终端环境注入等所有 LLM Provider 下拉里。 | `MediaProviderSection.tsx:112-130` |
| B2 | 保存媒体 Provider 后调用 `updateWorkspaceProvider`，**把工作空间的 CLI Provider 覆盖成图片 Provider**；反过来切换工作空间时又用工作空间的 LLM Provider 当媒体 Provider 默认值。 | `MediaStudio.tsx:130,185-189` |
| B3 | 协议不在 Provider 上，而是按 image/video 两个 studio 各存一份在 localStorage；切 Provider 不切协议，节点/运行记录里再塞一份 `providerProtocol` 作为路由 hack。 | `useMediaStudioStore.ts`、`apply_media_run_protocol` |

### C. 画布与节点模型

| # | 问题 | 位置 |
| --- | --- | --- |
| C1 | 每次点"生成"都新建一个 `MediaNode` + 一个 run。节点不是"可复用的生成器"，而是"一次生成的壳"；历史面板每个节点只显示最新一条 run；`replay` 也是复制成新节点。docs/22 设计的"节点反复生成保留历史"在 UI 上不存在。 | `MediaStudio.tsx:229-247`、`MediaHistoryPanel.tsx:101-105` |
| C2 | "画布空间"是假的：同一项目下所有项目画布都用 `legacyMediaLayoutId` 作为查询键，建 3 个画布看到同一张图；空间只存 localStorage（不进 SQLite、Web/桌面不共享）；`renameSpace`/`removeSpace` 没有 UI。 | `useMediaCanvasStore.ts`、`MediaStudio.tsx:141-161` |
| C3 | 节点没有删除、重命名、查看原图、下载、在文件夹中打开、复制路径；边不能删、不能拖线连接，只能从历史面板"用作输入"生成一条边。`deleteNode`/`updateNode` 服务层已有但无人调用。 | `mediaService.ts:154-163` |
| C4 | 轮询开销：每 5 秒 `listNodes + listEdges + N×(listRuns + listAssets + resolveAssetUrl [+ poster])`，历史面板再来 N×`listRuns`，WebSocket/Tauri 事件触发的又是一次全量刷新。30 个节点约 100 次 IPC/5s，且整个 `nodes` 数组替换导致全画布重渲染。 | `useMediaStore.ts:35-69,89-95`、`MediaCanvasView.tsx:68-80` |

### D. 表单

| # | 问题 | 位置 |
| --- | --- | --- |
| D1 | `MediaGenerationForm.tsx` 单文件 29KB，约 25 个参数无论 Provider 是谁都展示（OpenAI 下出现 sampler/CFG/codec/色彩空间）；`size` 和 `aspectRatio` 可同时编辑且互相矛盾；`quality: ultra` 是编的。 | `MediaGenerationForm.tsx:345-355` |
| D2 | 参考图走 `FileReader → base64 dataUrl → JSON IPC → Rust 解码`，上限 64MB × 32 张，全部经过 JSON 字符串。 | `MediaGenerationForm.tsx:51-62`、`MediaStudio.tsx:210-228` |
| D3 | ComfyUI 主表单只有"粘贴 API JSON"一条路；22KB 的 schema 驱动 `ComfyWorkflowEditor` 及模板控件仅有测试引用，没有挂载。 | `ComfyWorkflowEditor.tsx`、`ComfyWorkflowTemplateControls.tsx` |

### E. 工程

- docs/22 的"当前验证记录"全是 mock 单测与合约测试，没有任何真实 Provider 的录制 fixture；文中自己也承认"尚未宣称真实图片/视频模型端到端通过"。
- Rust 侧体量：`media_service.rs` 161KB、`comfy_adapter.rs` 75KB、`media_repo.rs` 66KB、`media_provider.rs` 60KB。执行指纹缓存、优先级队列、`/free` 显存释放这些都在没有一次真实生成的情况下写完了。
- 前端 18 个媒体组件里有 3 个（编辑器、模板控件、资源面板）是孤儿。

## 整改原则

1. **先跑通，再泛化。** 一个真实 Provider 的 t2i + edit 完整闭环（提交 → 下载 → 画布可见 → 可打开原图）优先于任何新能力。
2. **协议适配器按真实 API 形状写，不做"万能 JSON 透传"。** 每个协议维护自己的参数白名单和请求编码（JSON / multipart），前端表单字段由协议决定。
3. **媒体 Provider 与 LLM Provider 分离。** 不再互相污染，协议挂在 Provider 上。
4. **砍掉当前用不到的复杂度**，代码可以留在仓库里但不进 UI、不进验收清单：画布空间、本地 ComfyUI 运行时、指纹缓存 UI、调度器面板。
5. 每一阶段以"真机录制的 fixture 测试通过 + 手工走查清单"为验收，不再以"单测数量"为验收。

## 分阶段

### P0 止血（1–2 天，不引入新能力）

> **2026-09-03 落地记录**：本节全部完成。B1/B2 通过新增 `ProviderType::Media` 独立类型实现（媒体 Provider 不注入 CLI 环境、不占默认凭证位、被所有 CLI 兼容性过滤排除；`MediaStudio` 不再调 `updateWorkspaceProvider`，也不再用工作空间 LLM Provider 兜底）。A1 在 `NormalizedMediaRequest::to_wire_body` 按 kind 白名单构造并强制 `response_format: b64_json`。A3 的 `download_url` 放开为任意 HTTPS（保留大小/MIME/凭证校验，Bearer 仍只发给白名单 host）。A4 能力声明收敛为 image + t2i/i2i/edit、`supports_async_jobs: false`。A5 已由真实 `Sub2ApiMediaAdapter` + `docs/101-sub2api-media-api.md` 解决。表单 SD 参数（负面词/steps/cfg/sampler/seed/fps/codec/色彩空间）仅在 `comfyui` 协议下渲染。执行明细见 `issues/media-studio-p0.md`。

- 修 B1/B2：`MediaStudio.handleProviderSaved` 不再调 `updateWorkspaceProvider`；`handleWorkspaceChange` 不再用工作空间 LLM Provider 当默认媒体 Provider。给媒体 Provider 打标记（先用 `providerType: "media"` 或 metadata 字段），LLM 相关的所有 Provider 下拉过滤掉它。
- 修 A4：`OpenAiCompatibleMediaAdapter::capabilities()` 只声明 `image` + `textToImage` + `edit`，`supports_async_jobs: false`。视频与其它操作不再默认出现。
- 修 A1：在 `normalized_request` 或 `to_wire_body` 里按协议做白名单映射。OpenAI 兼容图片只保留 `model`、`prompt`、`n`、`size`、`quality`、`response_format`（强制 `b64_json`）、`background`/`output_format` 等真实字段；其余参数原样存进 `MediaRun.request` 但不发送。
- 修 A3：Provider 返回的输出 URL 只要是 HTTPS 就允许下载（保留大小/MIME/哈希校验），或直接靠 `b64_json` 绕开。
- 修 A5：删掉 `sub2api` 选项，或在文档里写清它到底是什么 API（见决策点 1）。
- UI 层把 `MediaGenerationForm` 里对 OpenAI 无意义的字段（steps/cfg/sampler/denoise/codec/colorSpace/resolution/frameMode）挂到 `protocol === "comfyui"` 条件下。

验收：对真实 OpenAI 兼容端点（决策点 1）完成 1 次 t2i、1 次 edit，图片出现在画布上并可打开原文件；Agent Chat 与终端 Provider 下拉不出现媒体 Provider。

### P1 真实 Provider 闭环 + fixture

- 挑定 2 个目标（决策点 1）：一个图片（建议 OpenAI `gpt-image-1`：`/images/generations` JSON + `/images/edits` multipart），一个视频（建议 OpenAI `/videos` 异步三段式，或用户实际在用的中转）。
- 为每个目标写独立适配器（`OpenAiImagesAdapter`、`OpenAiVideosAdapter`），替换现在的"通用 OpenAI 兼容"。`MediaProtocol` 枚举随之改为按 API 形状命名。
- 参考图上传改成 multipart：Tauri 侧读本地文件直接构造 multipart，前端只传路径/资产 id，不再走 base64 JSON IPC（解决 D2）。
- 把真实响应脱敏后录成 fixture，放进 `media_provider_tests.rs`，替代现在手写的 mock JSON。
- 前端 `getProviderCapabilities` 返回值按新适配器如实反映，表单据此渲染。

验收：录制的 fixture 测试通过；手工走查清单（t2i、edit、i2v、取消、失败重试、断网重启后状态恢复）全绿。

### P2 数据模型与 UI 收敛

- **媒体 Provider 独立实体**（决策点 4）：在 `cc-panes-core` 新增 `media_providers` 表或给 `providers` 加 `kind` 列，协议、提交路径、密钥都挂在实体上；`useMediaStudioStore` 里的 `protocol` 删除，`providerProtocol` 路由 hack 删除。
- **节点 = 可复用生成器**：节点保存参数，点"再次生成"在同一节点下新建 run；节点卡片显示 run 列表缩略图；历史面板按节点展开多条 run。删除节点、重命名、查看原图、下载/在文件夹中打开、删除边。
- **画布空间**（决策点 2）：建议直接删掉 `useMediaCanvasStore`，一个项目一张画布；如果一定要多画布，`layoutId` 必须每个空间独立且落 SQLite。
- 表单拆成 `ImageForm` / `VideoForm` / `ComfyForm` 三个文件，字段由 `capabilities` 中的 schema 驱动而不是硬编码。

### P3 性能与实时

- 后端新增聚合接口 `list_media_canvas(workspaceId, layoutId)`：一次返回节点 + 最新 run + 预览资产 URL + 边，替换现在的 3N+2 次调用。
- `media-job-changed` 事件只更新对应节点，不再触发全量刷新；轮询退到 15–30 秒兜底。
- 历史面板复用聚合接口结果，不再自己拉 `listRuns`。

### P4 ComfyUI 与高级能力（延后，独立立项）

- 远程 ComfyUI：补 API key 透传，用真实实例跑通一次再放回 UI；挂载 `ComfyWorkflowEditor`。
- 本地 ComfyUI 运行时：决策点 3。
- 指纹缓存、优先级调度、`/free` 面板：等 P1–P3 稳定后按需接入。

## 需要拍板的决策

1. **第一批真机验收用哪个 Provider？** OpenAI 官方、某个中转、还是 sub2api？sub2api 究竟是哪家的 API 形状——这决定 P1 适配器怎么写。
2. **画布空间砍不砍？** 建议砍，一个项目一张画布。
3. **本地 ComfyUI 运行时**：代码留着不暴露，还是这轮直接删掉 `comfy_runtime.rs` 及相关命令？建议留代码、删 UI 入口、从 docs/22 的"已落地"里划掉。
4. **媒体 Provider 是独立表还是 `providers` 加 `kind`？** 建议独立表，字段差异太大（提交路径、协议、下载策略）。

## 与 docs/22 的关系

docs/22 保留为架构设计参考，但"分阶段交付"和"当前验证记录"两节应加一行说明指向本文，并把 P1.5、P2、P3 中未在 UI 上可用的条目状态从"已落地"改为"底座已实现、UI 未接入、未真机验证"。

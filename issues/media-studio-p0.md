# 媒体工作台 P0 止血（docs/99）— 执行记录

对应 `docs/99-media-studio-rework-plan.md` P0 清单：Provider 分离 + 参数白名单 + 能力收敛 + 下载放行 + UI 条件渲染。

## 变更明细

### B1/B2 媒体 Provider 与 LLM Provider 分离
- `cc-panes-core/src/models/provider.rs`：新增 `ProviderType::Media`（serde `"media"`）；`to_env_vars` 对 Media 返回空（绝不注入 CLI 环境）。
- `provider_service.rs`：`native_cli_for_provider_type` 加 Media 分支；add/add_unique/update 三处默认凭证位写入跳过 Media 类型。
- `dsh_service/provider_mapping.rs`：Media 不生成 dsh 路由。
- 前端 `web/types/provider.ts`：union 加 `"media"`、`PROVIDER_TYPE_META` 补条目、新增 `isMediaProvider()`。
- `web/utils/providerCompatibility.ts`：`isProviderTypeCompatibleWithCli` 对 media 短路 false——所有 CLI 启动器/LaunchProfiles/Provider 面板分组全部自动排除。
- `MediaProviderSection.tsx`：保存 `providerType: "media"`；下拉只列 media 类型（旧的 open_ai 型媒体 Provider 需重新保存一次）。
- `MediaStudio.tsx`：删除 `handleProviderSaved` 对 `updateWorkspaceProvider` 的调用；工作空间/画布切换不再用 `workspace.providerId` 兜底媒体 Provider。
- `promptCopilotService`：media 类型不参与 LLM 补全。
- i18n：settings 加 `providerTypeMediaLabel/Desc`（en+zh）。

### A1 参数白名单（`media_provider.rs::to_wire_body`）
- 图片仅发送：`n`、`size`、`quality`、`background`、`output_format(+驼峰)`、`output_compression(+驼峰)`、`style`、`user` + `model`/`prompt`/`input`/`mask`；强制 `response_format: "b64_json"`。
- 视频仅发送：`n`、`size`、`seconds`、`duration`（该协议已不声明视频能力，保留兜底）。
- 其余 UI 参数照旧存 `MediaRun.request`，不上线。sub2api/comfy 有各自独立构造器，不受影响。

### A3 输出下载放行
- `download_url` 不再要求 host 在白名单内：任意 HTTPS（禁凭证/fragment）即可下载；大小上限、MIME、哈希校验保留；`Authorization` 仍只发给白名单 host；API 端点 (`remote_url`) 维持严格白名单。

### A4 能力声明收敛
- OpenAI 兼容适配器：`kinds: [image]`，`operations: [textToImage, imageToImage, edit]`，`supports_async_jobs: false`。前端按能力表渲染，视频入口在该协议下自然消失。

### A5 sub2api
- 无需改动：`Sub2ApiMediaAdapter` 已按 `docs/101-sub2api-media-api.md` 实现真实异步任务 API（白名单请求体、Idempotency-Key、授权下载）。docs/99 的"完全等价"描述已过时。

### UI 条件渲染（`MediaGenerationForm.tsx`）
- 负面提示词、steps/cfg/sampler/denoise、seed/seedMode、fps/codec/colorSpace/音频开关：仅 `comfyui`。
- frameMode、resolution：`comfyui`/`sub2api` 可见，`open_ai_compatible` 隐藏。
- quality 选项：非 comfy 协议为 `low/medium/high/auto`（去掉了虚构的 `ultra`），comfy 保留原有集合。

## 验证
- `cargo test -p cc-panes-core --lib`：1447 通过。
- `cargo check`：core / web / tauri 三 crate 通过。
- `tsc --noEmit` 通过；vitest：media 8 文件 19 用例 + providers/utils/stores/canvas 105 文件 1354 用例全过。
- 测试契约更新：`MediaProviderSection.test` 夹具改用 `media` 类型；`MediaGenerationForm.test` 改为断言 open_ai 协议下 SD 字段不渲染。

## 基础操作补全（同批次追加）

对应 docs/99 C3 的"节点没有删除、重命名、查看原图、下载、在文件夹中打开；边不能删"：

- 新增 Tauri 命令 `reveal_media_asset`（经 `MediaService::resolve_asset_path` 校验后 `reveal_item_in_dir`）；`mediaService.revealAsset`（桌面限定）与 `mediaService.deleteEdge`（Tauri `delete_media_edge` / Web `DELETE /api/media/edges/:id` 均已有后端）。
- `CanvasNodeLayer` 媒体节点头部改为操作菜单：查看原图/原片（resolveAssetUrl 新窗口打开）、在文件夹中显示（桌面）、再次生成（`replayRun` 最新 run，同节点新增 run）、重命名（`updateNode.title`）、移除全部连线（批量 `deleteEdge`）、删除节点。
- 画布空间：激活空间旁新增重命名/删除按钮（`useMediaCanvasStore.renameSpace/removeSpace` 首次接入 UI；删除仅移除命名视图，节点留在媒体图）。

## 迁移说明
- 此前在媒体工作台保存过的 Provider 是 `open_ai` 类型，现在不会出现在媒体 Provider 下拉里，需在媒体工作台重新保存一次（自动落为 `media` 类型）。它们仍留在 LLM Provider 列表中，可手动删除。

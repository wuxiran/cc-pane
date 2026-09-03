# 对照 neiwen.cn 移植功能到媒体工作台 — 执行记录

计划来源：`docs/100-neiwen-feature-port.md`（对 neiwen.cn 实测盘点 + 分阶段移植路线）。

## 已完成

### 阶段 A：画布节点子类型（文本/脚本/音频/站位板/分镜格子）
- 子类型标记存 `MediaNode.parameters.nodeSubtype`（无后端迁移；`kind` 列保持 image）。
- `web/types/canvas.ts` / `web/types/media.ts`：`CanvasMediaSubtype`、`mediaNodeSubtype()`、`mediaStoryboardShots()`、`toCanvasMediaNode` 子类型投影分支。
- `web/components/canvas/MediaSubtypeNodeCard.tsx`：文本/脚本/站位板内联编辑、音频（本地路径经 asset 协议 / URL 播放）、分镜格子（多格镜头、增删、缩略图）。
- `MediaCanvasView` 头部"添加节点"菜单；`CanvasNodeLayer` 媒体节点删除按钮 + 子类型徽标。
- `useMediaStore`：子类型节点跳过 run/asset 查询；新增 `refreshCurrent()`。

### 阶段 B：AI 提示词助手（对标"小文"，Cmd/Ctrl+K）
- `web/services/promptCopilotService.ts`：一次性补全，Anthropic 协议（anthropic/proxy/kimi）+ OpenAI 兼容（其余带 baseUrl 的），复用已保存 Provider。
- `web/components/media/MediaPromptCopilot.tsx`：生成/润色/扩写/译英四模式；输出可填入表单（`MediaGenerationForm.externalPrompt`）或存为文本节点。
- MediaStudio 捕获阶段 Cmd/Ctrl+K（压过全局命令面板）+ 头部按钮。

### 阶段 C：短剧生产流水线
- SQLite v38 迁移：`drama_projects` / `drama_episodes` / `drama_shots`（`cc-panes-core/src/repository/db.rs`）。
- `models/drama.rs` + `repository/drama_repo.rs` + `services/drama_service.rs`（含单测）。
- 三入口：Tauri `drama_commands.rs`（13 个命令）、Web `/api/drama/*` 路由、`AppState.drama_service`。
- 前端：`web/types/drama.ts`、`web/services/dramaService.ts`、`web/components/drama/DramaStudio.tsx`。
- 流程：剧本编辑 → LLM 拆分分镜（严格 JSON）→ 逐镜头/批量 t2i → 图生视频（i2v，取镜头图输出资产为输入帧）→ 状态轮询与预览；生成节点同时落在项目媒体画布。
- 入口：ActivityBar 短剧图标（`dramaGen` 模式，共用 `mediaGeneration` 实验开关）。

### 阶段 D：批量转绘
- `web/components/drama/BatchRestyleDialog.tsx`：统一风格提示词，对已有图的镜头批量 i2i；镜头指向新节点，旧图留在画布作历史。

### 阶段 E：画布级工作流模板
- `web/stores/useMediaTemplateStore.ts`（persist，上限 50）；`web/components/media/MediaCanvasTemplates.tsx`：保存当前画布（剥离 mediaScope）、应用（重建节点+连线）、JSON 导出/导入。

## 验证
- `cargo check`：cc-panes-core / cc-panes-web / cc-panes(tauri) 全部通过。
- `cargo test -p cc-panes-core`：迁移 14 个 + drama 4 个测试通过（迁移断言更新到 v38）。
- `tsc --noEmit` 全量通过；vitest media/canvas/stores 相关 1076 用例通过（MediaStudio.test 补 mock）。

## 实验开关（重构前的下线面）

全部新功能都在实验开关之下（`ExperimentalSettings`，dev 默认开、release 默认关）：

- `mediaGeneration`：媒体工作台整体（画布节点类型扩展、提示词助手、画布模板都挂在 MediaStudio/MediaCanvasView 内部，随开关整体消失）。
- `dramaStudio`（新增独立开关）：短剧制作台入口 + DramaStudio 全屏页 + 批量转绘。与 `mediaGeneration` 解耦，可单独下线重做。

大规模重构时的下线路径：关掉开关即可让入口消失；删代码时从 `useExperimentalFeature(id)` 调用点入手（tsc 会报出全部残留），SQLite v38 的 drama 三表与 `media_nodes.parameters.nodeSubtype` 数据保持向后兼容，可留待新实现读取或写迁移清理。

## 已知边界
- 真机 Provider 端到端仍受 docs/99 的 P0/P1 约束（协议白名单、真实 t2i/edit 闭环未完成前，生成请求可能被真实 API 拒绝）。
- 成片拼接（ffmpeg concat）未做，首版按镜头逐个预览/下载。
- 音频节点仅引用/播放，不接生成（后端无 audio kind）。

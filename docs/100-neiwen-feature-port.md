# 对照 neiwen.cn 的功能移植计划

2026-09-02 用真实账号登录 neiwen.cn（AI 短剧批量制作 SaaS）实测得到的功能盘点，以及移植到 cc-book 桌面媒体工作台的分阶段路线。上游现状盘点见 `docs/99-media-studio-rework-plan.md`，画布底座设计见 `docs/22-media-generation-canvas-plan.md`。

## neiwen.cn 功能地图（实测）

来源：登录后的画布/工作区 UI 走查 + 前端 bundle 路由表 + 站点 API（`/api/client/models`、`/api/site-config`、`/api/storage/packages` 等）。

### 创作画布（`/canvas`）

- 节点类型：文本、图片、视频、音频、脚本、站位板、文生图、图生图、文生视频、图生视频、**分镜格子**、上传
- 双击画布自由生成节点；小地图、缩放、画布设置、明暗主题
- 提示词工具 / "小文" AI 助手（Cmd+K）
- 资源库、我的工作流、历史记录、云同步、工作流模板、工作流分享（`/share/workflows/:publicId`）

### 短剧批量生产流水线

- 项目中心 `/workspace`：项目 → 剧集（集）管理、导入、教程
- 剧本 `/screenplays`；作品 `/works/:dramaId/:workspaceId`
- 短剧生成 `/generate/drama/:dramaId/:episodeId`：剧本 → 分镜 → 镜头 → 成片
- 转绘/风格化 `/studio/restyle`：批量图片风格化

### 托管模型中转（平台自带，非 BYO）

- 音频：Suno；对话：Doubao Seed 2.0、Deepseek V4、GPT-5.6、Gemini 3.7
- 图像：GPT Image 2、Gemini 3 Pro/3.1 Image、Seedream 5.0 Pro、Midjourney
- 视频：Seedance 2.0 等；按积分（牛马值）计费，区分线路/速度档

### 商业化与平台

积分体系、存储套餐（10/50/200GB）、支付/代金券/邀请码、分销 `/distributor`、社区 `/community`、技能市场 `/skill-market`、学院 `/academy`、资源中心 `/asset-hub`、企业团队（`/team/admin`、`/enterprise/quota`、企业空间角色、并发上限）、中转控制台 `/relay-console`、工单 `/ticket`。

## 移植范围决策

**不移植（SaaS 专属，与桌面 BYO-Provider 形态冲突或应独立立项）**：托管模型中转与积分计费、存储套餐/支付/代金券/分销、社区、技能市场交易、学院、企业配额/团队后台、中转控制台、云同步（桌面场景以本地 SQLite 持久化替代）。

**移植（创作与生产能力）**：

| 缺口 | neiwen 对应 | 阶段 |
| --- | --- | --- |
| 画布节点类型：文本、脚本、音频、站位板、分镜格子 | `/canvas` 节点菜单 | A |
| AI 提示词助手（Cmd+K copilot） | "小文" | B |
| 短剧生产流水线：项目→剧集→剧本→分镜→镜头→成片 | `/workspace`、`/generate/drama` | C |
| 批量转绘/风格化 | `/studio/restyle` | D |
| 画布级工作流模板与导入导出 | 我的工作流、模板、分享 | E |

## 前置依赖

移植的前提是 `docs/99` 的 P0/P1 完成（媒体 Provider 与 LLM Provider 分离、协议参数白名单、真实 t2i/edit 闭环）。本计划各阶段不重复处理这些问题，但实现上不得加深 docs/99 已指出的坑（例如继续往共享 Provider 表里塞媒体配置）。

## 分阶段设计

### 阶段 A：画布节点类型扩展

在现有 `MediaNode` 上增加节点子类型（不新增 Canvas 投影 kind）：

- `text` / `script`：纯文本节点，内容存节点参数，供 copilot 与流水线消费；无 run。
- `audio`：渲染 `<audio>`，生成走 Provider 能力表新增的 `audio` 类别。
- `board`（站位板）：占位分组容器。
- `storyboard`（分镜格子）：一个节点承载多格镜头缩略图，是阶段 C 流水线在画布上的载体。

触点：`web/components/media/MediaCanvasView.tsx` 渲染分支、节点创建入口、`web/types/media.ts` 子类型定义；后端如 `media_nodes` 已有 JSON 参数列则复用，否则新增 `node_subtype` 列（新迁移）。

### 阶段 B：AI 提示词助手（对标"小文"）

- 媒体工作台内 Cmd/Ctrl+K 唤起浮层：提示词生成、改写、扩写、翻译成英文提示词。
- 复用现有 LLM Provider 通路（Agent Chat 的 provider 接入），不新建 Provider 概念。
- 输出可一键填入生成表单，或落成文本/脚本节点。

触点：新增 `web/components/media/MediaPromptCopilot.tsx`；快捷键挂在 MediaStudio 容器上。

### 阶段 C：短剧生产流水线

数据模型（SQLite，`cc-panes-core` 新迁移）：

```text
drama (短剧项目) -> episode (剧集) -> screenplay (剧本文本)
episode -> shot (镜头: 序号/景别/台词/提示词/参考图/图资产/视频资产)
```

流程：剧本编辑 → LLM 拆分分镜（复用阶段 B 通路）→ 逐镜头文生图 → 图生视频 → 成片列表（拼接导出后续接 ffmpeg，首版先逐镜头下载）。

- 批量执行复用现有 `MediaJobWorker` 队列/lease/重试；镜头生成即普通 MediaRun，`shot` 记录 runId/assetId 引用。
- UI：新增 `web/components/drama/DramaStudio.tsx`（项目/剧集列表 + 镜头表格 + 批量操作栏）。
- 服务：`cc-panes-core/src/services/drama_*.rs` + Tauri commands + Web 路由，模式照抄媒体服务三入口。

### 阶段 D：批量转绘/风格化

- 选一批图片资产（或分镜格子内全部镜头图）→ 统一风格提示词/参考图 → 批量提交图生图 run。
- 结果回填原节点/镜头，保留原图为历史 run。
- 触点：复用阶段 C 的批量提交与阶段 A 的分镜格子；UI 为画布多选 + 批量操作面板。

### 阶段 E：画布级工作流模板

- 把画布子图（节点参数 + 连线，不含资产）保存为模板：本地模板库 + 文件导入导出（JSON）。
- 与现有 ComfyUI 模板（provider-scoped Zustand）区分：这是画布级、跨 Provider 的。

## 验收原则

沿用 docs/99：每阶段以真机走查清单为准，不以单测数量为准。每阶段独立 PR。

## 落地记录（2026-09-03）

A–E 五个阶段的代码已全部落地，明细见 `issues/neiwen-feature-port.md`。要点：

- 节点子类型经 `MediaNode.parameters.nodeSubtype` 承载，无媒体表迁移；短剧流水线新增 SQLite v38（`drama_projects`/`drama_episodes`/`drama_shots`）与 Tauri/Web 双入口。
- 提示词助手与分镜拆分直接调用已保存 LLM Provider（Anthropic 协议或 OpenAI 兼容），未新建 Provider 概念。
- 未做：成片 ffmpeg 拼接、音频生成（后端无 audio kind）、模板云同步。真机端到端仍以 docs/99 P0/P1 为前置。

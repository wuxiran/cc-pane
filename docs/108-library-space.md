# 108 · 资料空间：AI 原生的素材收集与自媒体创作

> 状态：**Proposal + Design（评审中）**（2026-10-22，基线 `dev/v0.12.22@80ce0e72`）。
> 参照：ChatGPT 桌面端「资料空间」的信息架构（左栏按类型分：全部 / 页面 / 幻灯片 / 站点 / 图像；顶部「你的作品 / 已上传」；「创建」交给 AI）。
> 前置阅读：`docs/72-workbuddy-commercialization.md`（助手体系 B3）、`docs/95-automations.md`、`docs/97-skill-market.md`、`docs/105-pebrel-borrow-upgrade-plan.md`（F1 快捷终端）。

---

## 0. 结论先行

| 问题 | 答案 |
|---|---|
| 做成什么 | 一个**资料空间**：素材和 AI 作品都是普通文件，放在一个专用工作空间里；CC-Panes 提供按类型浏览的视图 |
| 谁来干活 | 常驻的**素材助手**会话（Claude Code / Codex）。剪藏、视频转写、整理、拆解、写稿全部写成 **skills**，CC-Panes 不实现业务流程 |
| CC-Panes 新增什么 | 只有三样：**资料空间视图**、**投喂入口**（热键小窗、手机分享、「创建」按钮）、**投递管道**（把内容可靠交给指定助手：忙则排队、不在则恢复） |
| 数据存哪 | 只用文件（Markdown + 附件）。不建表、不迁移；视图在内存扫描 + 文件监听，搜索走元数据过滤 + ripgrep |
| 先做什么 | P0 模板 + skills（几乎零产品代码，当天可用）→ P1 投递管道 + 热键投喂 → P2 视图 → P3 手机分享 → P4 创作 → P5 剪藏与发布 |

**为什么不自建素材库**：第一版设计是 `library_items` 表 + FTS + 收件箱 UI + 剪藏流程，评审结论“不够 AI 原生”——CC-Panes 的优势在编排 AI 会话，自造一套 CRUD 产品既重复了 AI 本来就能做的事（读网页、写 Markdown、打标签），也让数据离开 CC-Panes 后不可用。

---

## 1. 背景

用户日常素材来自：手机刷到的抖音 / 小红书 / 公众号 / 知乎 / X；电脑浏览器；随手灵感（文字、语音、截图）；与 Claude / Codex 的对话产出；各种 skills。产出方向：短视频、图文长文、短帖 / 推文，尚未定型。

现有可复用能力（已核对代码）：

| 能力 | 位置 | 用途 |
|---|---|---|
| 工作空间 skills（目录型，可带 scripts，按会话挂载） | `cc-panes-core/src/services/workspace_skill_service.rs` | 资料空间的全部业务逻辑载体 |
| 工作空间创建 / 初始化 | `workspace_service.rs` `create_workspace` / `init_workspace_files` | 资料空间模板落地 |
| 会话投递 | orchestrator `submit_to_session`、`send_to_worker`（带 `pending_directives` 排队）、`dispatch_task`（新建 / resume） | 投递管道的零件 |
| 全局热键 + 单例 popup | `src-tauri/src/lib.rs`（global-shortcut）、`commands/quick_terminal_commands.rs` | 投喂小窗 |
| 截图 / 语音转写 | `screenshot_service.rs`、`voice_service::transcribe` | 小窗的截图、口述 |
| Automations（cron 起无头 ACP 会话） | `src-tauri/src/services/automation_service.rs` | 夜间整理 |
| 技能市场（已收录 write-xiaohongshu、short-video-scripter、baoyu-*、html-ppt 等） | `skill_market_*`、`skill-market/index.json` | 创作类 skills |
| 内置浏览器（自带 cookie 存储） | `browser_service.rs`，MCP 仅在 `/mcp-full` | 登录墙内容剪藏 |
| Web 远程访问 + 移动端 | `cc-panes-web`、`cc-panes-mobile` | 手机投喂 |

缺口：按名字定位常驻会话；不依赖 TaskBinding 的“忙则排队”投递；会话不在时“恢复后投递”；LaunchProfile 没有 `system_prompt`；没有工作空间模板机制；截图目录不可配置且会过期清理、语音不落盘；移动端没有分享入口。

---

## 2. 目标 / 非目标

**目标**
- 任何地方看到的素材，一步投进资料空间，由 AI 自动整理成可检索的 Markdown。
- 短视频链接能自动下载并得到带时间戳的文字稿（用户确认为核心需求）。
- 从素材到作品（长文、短帖、视频脚本、幻灯片、站点、配图）全程在 AI 会话里完成，作品回到资料空间。
- 数据离开 CC-Panes 仍然可用（Obsidian、Git、其他 AI 工具直接读）。

**非目标**
- 不建素材数据库、不做表单式录入流程。
- 不做多平台自动发帖（只做到生成各平台版本 + 公众号推送 skill + 打开发布页）。
- 不做批量爬取。视频下载仅限用户主动投喂的单条链接，供个人学习研究。
- 不做语义检索（embedding）；以后需要时作为 skill 或独立索引加，不进 P0–P5。

---

## 3. 设计

### 3.1 资料空间目录

默认 `~/CC-Panes-Library/`，可在设置中更改，可放进 Git / 同步盘。由模板一键创建为一个工作空间（项目即该目录）。

```
CLAUDE.md / AGENTS.md          # 约定：目录、frontmatter、处理规则。助手靠它干活
skills/                        # 工作空间 skills（.claude-plugin/plugin.json + skills/<name>/SKILL.md + scripts/）
inbox/                         # 投喂入口写入的原始件；助手处理后移走
uploads/YYYY/MM/<id>-<slug>/   # 「已上传」：收集来的素材，index.md + assets/
works/YYYY/MM/<id>-<slug>/     # 「你的作品」：AI 产出
.trash/                        # 回收站
```

`index.md` frontmatter（全部可选，缺省按扩展名推断类型）：

| 字段 | 说明 |
|---|---|
| `type` | `page` `slides` `site` `image` `video` `audio` `idea` `skill` `link` |
| `title` / `summary` / `tags` | 展示与检索 |
| `platform` / `url` / `author` | 来源（`douyin` `xhs` `bilibili` `youtube` `zhihu` `wechat` `x` `web` `local` `ai`） |
| `created` | ISO 时间 |
| `sources` | 作品引用的素材 id 列表 |
| `status` | `new` `organized` `used`，助手维护 |

类型推断：`.md` → page；`.html` 且目录含 `slides` 标记 → slides，否则 site；图片 → image；视频 → video；音频 → audio。

### 3.2 素材助手与投递管道

这是本专项唯一需要新写的通用底层，其他场景（任何“发给某个固定 AI”）也能复用。

1. **命名助手注册表**：`name → { profileId, cwd, sessionId?, resumeId? }`，存于数据目录 JSON。资料空间模板注册 `素材助手`。会话启动 / 退出时回写 sessionId / resumeId。
2. **LaunchProfile.system_prompt**：补齐 docs/72 B3，接到已有的 `append_system_prompt`（`cc-panes-core/src/models/terminal.rs`）。素材助手的系统提示只写“你是资料空间的素材助手，规则见 CLAUDE.md”，具体规则留在文件里。
3. **`deliver_to_assistant(name, text, attachments[])`**：

   | 助手状态 | 行为 |
   |---|---|
   | 会话存在且空闲 | `submit_to_session`（长文本沿用 `externalize_long_prompt`） |
   | 会话存在但忙 | 入队；会话回到 idle 时按 FIFO 补投（从 `send_to_worker` 的 `pending_directives` 抽出不依赖 TaskBinding 的通用队列） |
   | 会话不在 | 有 resumeId 则恢复，否则按 profile 新建；`wait_for_session` 到 idle 后投递 |

   附件先写进 `inbox/`，消息里只带路径。暴露为 Tauri 命令、MCP 工具（core 面）、cc-panes-web `POST /api/inbox`。

### 3.3 投喂入口

所有入口只做两件事：**写 `inbox/` → `deliver_to_assistant("素材助手", …)`**。

| 入口 | 期 | 说明 |
|---|---|---|
| AI 对话里直接说“存下来” | P0 | 任何挂载了资料空间 skills 的会话都能写文件；无需产品代码 |
| 热键投喂小窗 | P1 | 新设置 `settings.inbox.shortcut`；仿快捷终端单例 popup；文字 / 粘贴链接 / 拖文件 / 截图（拷贝进 inbox）/ 语音（转写文本写入 inbox） |
| 资料空间「创建」与多选「用这些创作」 | P2 | 输入需求，带上选中条目路径投递 |
| Agent Chat 消息菜单「发送到资料空间」 | P2 | |
| 手机分享 | P3 | Android `ACTION_SEND` / iOS Share Extension → `POST /api/inbox`（multipart，复用 web 登录 cookie 与 Origin 校验） |
| 内置浏览器「发送到资料空间」 | P5 | 带当前 URL 与选区 |

### 3.4 Skills（业务逻辑全部在这里）

随模板放在 `skills/`，用户可改。

| skill | 期 | 要点 |
|---|---|---|
| `ingest` | P0 | 处理 `inbox/` 新件：识别类型 / 平台，按需调用下列 skill，生成 `uploads/…/index.md`，移走原件 |
| `video-transcribe` | P0 | `scripts/` 内脚本：`yt-dlp` 下载（可选 `--cookies-from-browser`）→ 优先平台字幕 → 否则 `ffmpeg` 抽音频并切片 → ASR（本地 whisper.cpp；或 OpenAI 兼容转写 API）→ `transcript.md`（带时间戳）+ 封面 + 元数据。依赖自检，缺失时给 brew / winget 安装命令，并只保存链接与文案。首次使用需确认“仅个人学习研究” |
| `organize` | P0 | 摘要、标签、金句、爆款结构拆解（钩子 / 结构 / 金句 / 可复用句式），更新 frontmatter |
| `web-clip` | P5 | 知乎 / 公众号 / X → Markdown + 图片；登录墙时经 `cc-panes-ctl call browser_*` 使用内置浏览器 |
| `create-*` | P4 | 公众号长文、知乎回答、小红书图文、X 线程、短视频脚本 + 分镜、幻灯片、单页站点、配图；产出写 `works/`，`sources` 记录引用。优先引用技能市场已有条目 |

夜间整理：模板预置一个 Automation（cron 每晚、cwd = 资料空间、prompt = 按 `organize` 处理 `status: new` 的条目）。状态全在文件里，无头会话与常驻助手不冲突，`automation_service` 无需改动。

### 3.5 资料空间视图

信息架构对齐参照截图：

- 左侧活动栏新增「资料空间」。面板：创建；全部 / 页面 / 幻灯片 / 站点 / 图像 / 视频 / 灵感；最近；回收站。
- 主区：「你的作品」（`works/`）/「已上传」（`uploads/`）两个标签；搜索框；卡片网格。空状态引导“让素材助手创建”。
- 详情预览：复用 `MarkdownPreview`、`ImagePreview`；新增视频播放器；站点 / 幻灯片用沙箱 iframe。
- 卡片操作：用这些创作、发送给助手、在文件树中显示、复制路径、移到回收站。
- 后端：`library_scan(root)` 遍历并解析 frontmatter，内存缓存；文件监听推增量事件；搜索 = 元数据过滤 + ripgrep 正文。

---

## 4. 分期与任务

| 期 | 交付 | 验收 |
|---|---|---|
| **P0 能用起来** | 模板目录（CLAUDE.md / AGENTS.md / 目录骨架）+ skills：`ingest`、`video-transcribe`、`organize`；创建资料空间的入口（设置页按钮或 ctl 命令）；用现有 `dispatch_task` 起“素材助手” | 在助手会话里贴抖音、B 站、YouTube 链接 → 得到视频 + 带时间戳文字稿；说“把这段存下来”→ `uploads/` 出现条目，frontmatter 符合约定 |
| **P1 投递管道 + 热键投喂** | 助手注册表；`deliver_to_assistant`（三种状态）；LaunchProfile.system_prompt；热键投喂小窗 | 热键贴链接，助手空闲 / 忙 / 已关闭三种情况都被处理；重启 app 后仍可投喂 |
| **P2 资料空间视图** | 活动栏入口、分类、标签页、搜索、卡片、预览、「创建」与多选创作、Agent Chat 发送 | 与参照信息架构一致；外部修改文件后视图实时更新 |
| **P3 手机分享** | `POST /api/inbox`；Android / iOS 分享入口 | 手机分享小红书视频链接 → 桌面自动转写入库 |
| **P4 创作与整理** | `create-*` skills；技能市场缺失条目一键补装；夜间整理 Automation 预置 | 3 条素材 → 公众号草稿 + 短视频脚本 + 一套幻灯片，均出现在「你的作品」 |
| **P5 剪藏与发布** | `web-clip`；一稿多平台；公众号推送 | 知乎 / 公众号 / X 各剪一篇完整；草稿一键出 3 个平台版本 |

每期一个分支 + PR，合入 `dev/v0.12.x`。

---

## 5. 风险与合规

- **视频下载**：只处理用户主动投喂的单条链接；首次使用明确提示“仅供个人学习研究，请遵守平台条款与版权”；不提供批量、定时抓取。
- **登录态**：`--cookies-from-browser` 由用户显式开启；内置浏览器的 cookie 不导出给 skill 以外的进程。
- **体积**：视频与音频进 `assets/`，模板 `.gitignore` 默认忽略 `*.mp4 *.m4a *.wav`，避免同步盘 / Git 膨胀。
- **外部依赖**：yt-dlp、ffmpeg、whisper.cpp 不随包分发（P0），skill 内自检并给安装命令；后续视需要做成可选 sidecar。

---

## 6. 已定决策（2026-10-22）

1. 默认路径 `~/CC-Panes-Library/`，创建时可改；多设备同步由用户自行放 Git / 同步盘。
2. ASR 默认本地 whisper（whisper.cpp / faster-whisper，离线、不上传内容）；脚本保留云端 OpenAI 兼容转写接口作为可选项。
3. 素材助手默认 Claude Code；模板同时提供 `AGENTS.md`，换 Codex 也能用。

## 7. 待评审决策点

1. 活动栏入口是否对所有用户默认显示，还是在创建资料空间后才出现。

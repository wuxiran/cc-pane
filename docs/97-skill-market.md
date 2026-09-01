# 技能市场（Skill Market）

> 0.12.10 · 独立全屏页 · 聚合三源 · 目录型技能安装

## 为什么重做

0.12.9 之前的「Skill 市场」只是设置页里的一个平铺列表，数据源是 `skill-market/index.json` 里 9 条设计类条目，而且 9 条都缺 `contentUrl` / `sha256`，实际上一条都装不上。安装模型是「一个技能 = 一个 SKILL.md」，而开放的 [Agent Skills](https://agentskills.io) 标准里技能是**目录**（`SKILL.md` + `scripts/` + `references/` + `assets/`），社区绝大多数技能都是目录型。

本次目标对齐主流技能商店的形态：精选横排 + 分类页签 + 搜索 + 一键安装，内容靠聚合公开注册表而不是手写。

## 三个内容源

| 来源 | `source` 值 | 怎么拿 | 量级 |
|------|-------------|--------|------|
| 自维护精选清单 | `curated` | `skill-market/index.json`，远端 `raw.githubusercontent.com/wuxiran/cc-panes/main/...`；**同一份文件 `include_str!` 进二进制做基线**，远端条目按 id 覆盖内置 | 30+ 条，偏中文场景（公众号/小红书/论文/PPT/翻译）+ 社区高装机量 |
| Anthropic 官方仓库 | `anthropics` | 走 GitHub tree API 一次列出 `anthropics/skills`，取 `skills/*/SKILL.md`，并发 6 拉 frontmatter；磁盘缓存 24h | 约 20 条 |
| skills.sh 社区 | `skills-sh` | 搜索框联网 `GET https://skills.sh/api/search?q=`；结果只有 name/source/installs，描述靠 `describe` 懒补 | 搜什么有什么，截 60 条 |

合并规则（`SkillMarketCatalog::merge`）：先按 id 去重，再按（仓库, 文件夹 leaf）去重——同一个上游技能可能同时以精选、发现、搜索三种身份出现，只留优先级高的那份。精选 > 发现 > 搜索。

## 目录型技能安装

`SkillMarketEntry` 新增 `repo` / `path` / `gitRef` / `source` / `featured` / `installs`。`repo` 非空即目录型，走 `SkillMarketService::install_from_repo`：

1. `SkillRepoFetcher::list_files` 列出仓库全部文件（**GitHub 失败自动回退 jsDelivr 镜像**，成功过一次就记住偏好，国内网络不用每次等 GitHub 超时）
2. `RepoListing::locate_skill_dir`：显式 `path` 有 `SKILL.md` 就用；否则找最浅的 `<leaf>/SKILL.md`；仓库本身就是单技能则用根目录。skills.sh 只给 leaf 名，靠这一步定位
3. `select_repo_files`：硬上限 300 文件 / 30 MB 总量 / 单文件 8 MB；超限的辅助文件跳过并 warn，`SKILL.md` 缺失或超限直接失败；跳过 `.git/`
4. 并发 6 下载到 `~/.cc-panes/skills/user/.staging-<id>/`，全部落盘后 `rename` 到 `<id>/`——失败不留半成品
5. 从 `SKILL.md` frontmatter 读 name/description/license，写 `skill.json`；`sourceUrl` 指向 `github.com/<repo>/tree/<sha>/<dir>`，`version` 记 commit sha 前 12 位

安全边界：所有路径过 `is_safe_relative_path`（拒绝 `..`、绝对路径、反斜杠、盘符）；只下载写盘，**不执行**任何脚本。单文件条目（`contentUrl` + `sha256`）保留原路径不变。

`~/.cc-panes/skills/user/<id>/` 由启动档技能策略经 session prompt 注入；本次在每条用户技能前面追加一行 `Skill directory: <绝对路径>`，让 agent 能找到目录里的 `scripts/` 与 `references/`。

## 分类

固定 12 个分类 id（`CATEGORY_IDS`，前端 `CATEGORY_ORDER` 同步）：`dev` `docs` `data` `learning` `agent` `productivity` `content` `work` `search` `design` `life` `other`。精选清单显式给；发现与搜索条目用中英关键词投票（`categorize`），`dev` 放最后因为几乎所有技能都会提到 code。旧值 `design-visual` 映射到 `design`。

## 前端

- 入口：活动栏 `Store` 图标（`appViewMode: "skillMarket"`，与媒体工作区同模式，keep-alive）；设置 → 工具 → Skills 里也有「打开技能市场」
- `web/components/skillmarket/`
  - `SkillMarketPage.tsx` 布局与编排
  - `SkillMarketCard.tsx` 卡片（字母图标按名称哈希到 `--app-tag-*` 色板，来源角标，安装/卸载）
  - `useSkillMarket.ts` 数据：目录加载、350ms 防抖搜索 + 序号竞态守卫、描述懒补全（并发 3，只补首屏 36 张）、安装/卸载
  - `skillMarketModel.ts` 纯函数（分类/精选挑选/格式化），有单测
- i18n 新命名空间 `skillMarket`

## 命令

| 命令 | 说明 |
|------|------|
| `list_skill_market_entries(refresh?)` | 目录 = 精选 + 发现；`refresh` 跳过 24h 缓存 |
| `search_skill_market(query)` | 本地过滤 + skills.sh |
| `describe_skill_market_entry(entry)` | 补描述/路径：skills.sh 条目先读其页面 JSON-LD（不耗 GitHub 配额），否则读仓库 `SKILL.md`；结果落 `market-describe-cache.json` |
| `install_skill_market_entry(entry)` | 安装（前端把整条 entry 传回来，因为搜索结果不在缓存目录里） |
| `list_skill_market_categories()` | 分类 id |
| `install_market_skill(id)` | 旧命令保留，改为在聚合目录里查 id |

## 网络与配额

- GitHub API 匿名 60 次/小时。每个仓库列文件 1 次；发现结果缓存一天；skills.sh 搜索结果的描述走 skills.sh 页面而非 GitHub。设 `CCPANES_GITHUB_TOKEN`（或 `GITHUB_TOKEN`）可提额
- jsDelivr 镜像：`data.jsdelivr.com/v1/packages/gh/<owner>/<repo>@<ref>?structure=flat` 列文件，`cdn.jsdelivr.net/gh/...` 取内容；无 ref 时试 `main` 再 `master`
- `CCPANES_SKILL_MARKET_DISCOVERY=off` 关闭上游发现（测试/离线用）
- `CCPANES_SKILL_MARKET_INDEX_URL` 覆盖精选清单地址（原有）

## 验证

- 后端单测 36 项（fetcher 路径安全 / 定位 / 限额 / 合并去重 / 分类 / JSON-LD 提取 / 内置清单全量可装校验）
- `live_install_anthropics_pdf_skill_end_to_end`（`#[ignore]`，`cargo test -p cc-panes --lib -- --ignored live_install`）：真网装 `anthropics/skills` 的 `pdf`，断言 `scripts/` 落盘、目录含 anthropics 发现、搜索含 skills.sh 结果、describe 有描述。本次实跑 8s 通过

## 明确不做

- 不同步到 `~/.claude/skills` / `~/.codex/skills`——用户技能仍由启动档策略经 session prompt 注入，避免和 CLI 原生目录打架；后续若要做「原生落地」应是独立开关
- 不做评分/评论/作者页；skills.sh 的安装量只做展示
- 不做技能更新检测（`version` 记 sha，重装即更新）

# PR #55 审查 — Provider / 设置 / 终端状态栏 / 主题部分

> 只读审查。diff 来源 `.claude/pr55.diff`（594KB，全量）。恢复链路（useTerminalSessionRestore / daemon / cold restore）由另一 agent 负责，本文不覆盖其正确性，仅在冲突面处提及。
> PR 元数据：`dev_zhengjunkj` → main，**GitHub 已判 CONFLICTING**。merge-base = `0591742`，main 此后有 16 个提交，其中 `ea8d55d`（Provider 两页 UI 大重构）是冲突主源。
> PR 实际含 **11 个 commit**，PR 描述只写了 5 个——`fix(frontend) 懒加载分片`、`feat(theme)`、`feat(terminal) 路径链接`、`fix(provider) 上下文窗口用量`、`chore package-lock`、`feat(provider) 模型行容量预设` 共 6 个未在描述中列出。

---

## 1. 与 main 的冲突面（Provider UI）

双改文件（PR 与 main 都动了）共 22 个，Provider 相关的核心冲突：

| 文件 | main 侧（ea8d55d 等） | PR 侧 | 冲突性质 |
|---|---|---|---|
| `ProviderModelsEditor.tsx` | 原生 `<select>` → Radix `Select`（SELECT_NONE 哨兵）、背景 token `--app-content`→`--app-panel-bg` | **整体重写**为卡片式 FieldRow 布局 + 容量预设下拉（仍用原生 `<select>`），基于旧版写的 | **两侧同文件重写，文本冲突全域**；语义上 PR 回退了 main 的 Radix Select 迁移与 panel-bg token 迁移 |
| `LaunchProfilesPanel.tsx` | **拆掉 1742 行**，模型下拉移入 `LaunchProfileBasicsCard.tsx`（main 上 `useProviderDefaultModel` 只在那里出现） | 在 1342 行附近给模型下拉加 `providerModelOptionLabel`（拼 contextWindow 文案） | **PR 修改的代码在 main 上已不存在**。文本冲突 + 语义迁移：这段逻辑合并时必须手工搬到 `LaunchProfileBasicsCard.tsx` |
| `ProviderFormPanel.tsx` | `ProviderTypeOptions`→`ProviderTypeSelect`、`--app-content`→`--app-panel-bg`（改动 8+/11-，较小） | duplicateSeed 入参、contextWindowTokens 校验、lazyWithRetry 替换 | 中等文本冲突，语义兼容（新 UI 下 duplicateSeed 机制依然成立） |
| `ProvidersPanel.tsx` | 39+/55-（ProviderPagesHeader / ui/card 化） | duplicateSeed state + 3 个 handler 清理 | 中等文本冲突，语义兼容 |
| `web/test/lineRatchet.baseline.json` | `LaunchProfilesPanel` 2139→**577**、`ProviderFormPanel` 700 | `ProviderFormPanel` 700→**701**、保留 LaunchProfilesPanel 2139 | 直接冲突，需按 main 重算 |
| `web/test/colorGuard.test.ts` | 删 `ProviderAvatar` 11 条 hex（迁到 `--app-identity-provider-*`） | 加 `WallpaperPreview.tsx: ["#000"]` 一条 | 同一 ALLOWLIST 对象，文本冲突，合并简单 |
| `web/assets/index.css` | `:root`/`.dark` 各加 ~29 行（`--app-cli-*`、`--app-identity-*`） | 追加 4 个 `[data-theme]` 主题块（~350 行） | 文本上可能不冲突（不同位置），**语义缺口见 §4** |

**结论**：Provider 三件套不能机械合并。PR 的功能语义（复制走 add、上下文窗口字段、容量预设）在 main 新 UI 下都成立，但 `ProviderModelsEditor` 与 `LaunchProfilesPanel` 两处必须以 main 版本为底座**重做**（Radix Select 版编辑器 + BasicsCard 里的下拉），不是解冲突能解决的。

## 2. `feat(cli-adapter)` — Claude Provider `--settings` 注入（498744b6）

**与 managed 写入边界一致：通过。**
- 只写自己的文件 `<data_dir>/claude-provider-<sessionId>.json`（`crate::atomic_file::write_atomic` 原子写），完全不碰 `~/.claude.json` / 用户 `settings.json`（`claude.rs` 新增 `generate_provider_settings`）。「用户配置只读」承诺保持。
- 生命周期与 `mcp-<sessionId>.json` 先例完全对齐：同前缀 + `.json` + `>1h` mtime + 跳过当前文件（`cleanup_stale_provider_settings`，与 `claude.rs:187` 老 mcp 清理逻辑同构）。惰性清理——文件在会话结束后最多滞留到下次启动，与 mcp 先例同等水位，可接受。
- 秘密不进 CLI args（测试断言 `provider-secret` 不出现在 args）；`MANAGED_PROVIDER_ENV_OPTION = "__ccpanesProviderEnv"` 带注释声明永不日志。`terminal_service.rs` 注入点限定 `Claude && Managed`，注入的是 `local_adapter_options` 局部副本，不污染共享 options。

**三个待作者确认点**：
1. **空串 reset 语义未经真机验证**：`PROVIDER_ENV_RESET_KEYS` 缺失键补 `""`（`env.entry(k).or_default()`）。`ANTHROPIC_BASE_URL=""` 在 Claude CLI 里是「视为未设」还是「非法 URL 报错」？测试只断言了文件内容，没有验证 CLI 行为。需 Windows 实测一次 managed 启动。
2. **模型五键全写**（含 `CLAUDE_CODE_SUBAGENT_MODEL` 与三档 DEFAULT_*_MODEL 都写同一个 model id）：subagent 也被钉死在主模型上，对「主 opus + 子 haiku」类配置是行为变化，应在 PR 描述或 docs/77 里明说。
3. settings 文件里 API key 明文落盘（data_dir 内），与 mcp 文件先例一致但多了 credentials；建议注释标注 + 确认 data_dir 权限。

`provider_resolver` 冲突键补 5 个 model env key + 测试，正确且必要（否则 shell 里的 `ANTHROPIC_MODEL` 会绕过冲突检测）。

## 3. `feat(settings)` 两开关 + `feat(terminal)` 状态栏（3000d4d9 / 9db6824f）

**缺字段回落：通过。** `settings.rs` 两字段都是 `#[serde(default = "default_true")]`，并带 `terminal_settings_without_show_status_bar_defaults_to_true` 老 toml 解析测试；前端 `useSettingsStore` 默认值、`testData.ts`、`TerminalSection` 的 `value.showStatusBar ?? true` 三层都补了。符合 CLAUDE.md「新增字段必须可缺失」。

**useContextUsageStore 改 Map：有泄漏。** `sessions: Map<string, ContextUsageEntry>` **没有任何删除路径**——全 diff grep 不到 `sessions.delete`/清理逻辑，会话退出（terminal-exit / kill）后条目永久留存。单条约几百字节、长跑多会话场景缓慢累积。同时保留的顶层 `snapshot/lastReady`（active session 镜像）与 Map 双写增加了复杂度。**建议作者：在会话退出事件里清 Map 条目，或加 LRU 上限。** 另外 poller 侧 in-flight 去重（`previous.loading`）与 requestId 校验写得对，同一 session 多面板轮询不会互相覆盖——修复了「激活终端覆盖所有终端快照」的老 bug，这部分质量好。

**Panel 每 pane 状态栏对高度的影响：处理正确但与文案不符。**
- `Panel.tsx`: `showTerminalStatusBar = collectPanels(rootPane).length > 1 && !isFullscreenPanel`——单 pane / 全屏不渲染，避免挤高度；用的是 store 工作副本 `rootPane`（符合 CLAUDE.md「活树在 rootPane 上」的 gotcha）。
- `TerminalTabContent` 外层改 `flex flex-col min-h-0`，终端区 `flex-1 min-h-0`，状态栏 `h-7 shrink-0`——布局收缩链正确，xterm fit 不会被空条顶掉。
- 但 settings 文案说「每个终端底部的状态栏」，实际**单 pane 布局永远看不到**（信息在全局 StatusBar）；开了开关却看不到条，会被当 bug 报。建议 hint 文案补一句「多分屏时显示」。
- 小问题：i18n `statusBarShow`（"显示状态栏"）两语言都加了但**无任何调用点**（右键菜单只有 hide），死 key。

`enabled = isVisible && layoutActive` 让后台 pane 不轮询——与「不给全部注册项目起常驻轮询」的项目纪律一致，好。

## 4. 描述里没提的三个 commit

### `feat(theme)` 多主题预设（f6ffe8f1）
- 结构：`web/theme/themePresets.ts`（82 行，6 预设 + canonical 映射）、`ThemeSection`（106 行）、`ThemeSwatches`（66 行）、`useThemeStore` 重写（保留 `isDark` 兼容 selector，`dataset.theme` + `.dark` class 双写）、StatusBar 主题按钮改 DropdownMenu。旧 localStorage `light/dark` 平滑映射到 classic-white/deep-ink，`ThemeSettings.mode` 类型注释同步。质量整体不错，i18n 双语齐全。
- **确实动了 index.css，但没碰 main 新加的 token 结构**：4 个新主题块是纯追加。语义缺口：**新主题块不含 main 上刚加的 `--app-cli-*` / `--app-identity-provider-*`**（写在 ea8d55d 之前），合并后这些 token 走 `:root`/`.dark` 继承——因为暗主题同时挂 `.dark` class，继承值是对的，**不算 bug**；但 `colorGuard` 的「:root 与 .dark token 全等」测试**不覆盖 4 个新主题块**，以后任何 token 在新主题里漂移都测不出来。建议作者把 parity 测试扩到所有 `[data-theme]` 块（至少断言其 `--app-*` 集合 ⊆ `:root` 集合）。
- 交互小疑点：`ThemeSection.selectTheme` 同时「立即 `setThemeMode` 生效」+「写 settings draft」；draft 若被放弃，视觉主题与持久化 `theme.mode` 会短暂不一致（StatusBar 下拉那条路径是即时保存的，两个入口行为不同）。
- `themePresets.ts` 里的 hex swatch 是主题身份数据，且 `web/theme/` 不在 colorGuard 扫描范围（只扫 `components/**`）；`ThemeSwatches` 用 style 动态值，不触硬编码护栏。合规。

### `feat(terminal)` 路径链接对话框（ec20f1f4）
- 覆盖面大：core 新 service（241 行）+ 集成测试 + Tauri commands（222 行）+ daemon/server.rs + cc-panes-web 路由 + web_auth 只读 POST allowlist + 前端 lib（~350 行）/service/store/dialog（162 行）/registration。
- 安全姿态好：拒 URI scheme（带 `C:` 盘符白名单）、控制符/bidi 不可见字符、`\\?\`/UNC 原始输入、相对路径逃逸计数、canonicalize 后二次 containment（Windows 大小写不敏感比较 + WSL UNC 前缀测试）、ssh 一律拒绝、`web_auth` 把 resolve 加进只读 POST 白名单并有测试。errors.json 11 个错误码双语齐全。
- 一个真问题：**`TerminalPathLinkDialog.openEditor` 调 `usePanesStore.getState().openEditor(...)` 没传 `{ forcePaneTab: true }`**。按 CLAUDE.md gotcha（`editorTabActions.ts:70-75`），用户在 Files 视图下点终端里的路径链接会静默返回 null、分屏区毫无反应。终端在分屏区里，属于「分屏区内的调用方」，应传 forcePaneTab（或按产品意图明确落 Files 视图并切换视图）。
- 体量上这是一个完整的独立 feature，与本 PR 其他内容零耦合，**建议拆成独立 PR**。

### `fix(frontend)` 懒加载分片自愈（82ef428b）
- `lazyRetry.ts`（141 行）+ 200 行测试 + ErrorBoundary 配套 + TabContentRenderer/SettingsPaneContent 逐 tab / 逐分区隔离边界。设计说明（module map 按 URL 缓存失败、cache-bust query、`moduleMatchesHint` 防止把依赖模块当组件返回）写得很清楚，非模块错误直通 ErrorBoundary。质量高、独立、低风险，**可直接收**。
- 注意 `SettingsPaneContent` / `TabContentRenderer` 与 main 无冲突（不在双改列表）。

### `fix(provider)` 上下文窗口与用量显示（d7a7c331，同样未在描述）
- 全栈链：`ProviderModel.context_window_tokens`（Rust+TS+校验 1k–10M）→ **DB migration v30**（launch_history 加 `model_id`，带 v29 保留测试、幂等测试；main 目前 stop at v29，无版本号冲突）→ `launch_history` 全链传 model_id → `usage_stats_service` 窗口解析重构：Claude 不再硬编码 200k，优先 jsonl 实测窗口，缺失时回落 provider 模型配置，再缺失降级为 `WINDOW_UNKNOWN` 的 ready 快照（有用量、无百分比）而不是整个报 error——这修复了第三方 provider 上「用量指示器恒 200k / 恒错误」的实际问题。`ready_snapshot` 百分比改 checked 运算。方向和质量都好。
- 依赖注入方式（`new_with_provider_and_settings` 四构造器组合）略啰嗦但可用；`src-tauri/lib.rs` 把 provider_service 提前构造，注意与 main 的 lib.rs 改动（+32 行）有合并摩擦。

## 5. 四道前端护栏

| 护栏 | 结论 |
|---|---|
| hex 硬编码 | 通过。新增组件全部走 `var(--app-*)`；唯一新增直接色 `WallpaperPreview` 的 `#000`（dim 层中性黑）已按先例登记 colorGuard allowlist；index.css 主题块本身就是 token 定义处。themePresets swatch hex 属身份数据、在扫描范围外。 |
| i18n 双语 | 通过（en/zh 全对齐：theme.presets、providerContextWindow.*、terminalPathLink.*、TERMINAL_PATH_* 错误码、showStatusBar/showContextUsage、coldRestore*）。两处瑕疵：`statusBarShow` 是死 key；zh common.json 新增行沿用 \u 转义混排（与文件现状一致，不算新问题）。 |
| 新文件行数 | 通过。最大新文件 `terminal_path_link_service.rs` 241 行、`TerminalPathLinkDialog.tsx` 162 行、`lazyRetry.ts` 141 行，全部 <800。lineRatchet 唯一上调是 ProviderFormPanel 700→701（+1，可接受，但基线与 main 冲突需重算）。 |
| 裸中文 | 通过。UI 字符串全走 t()；中文只出现在注释与 docs。 |

## 6. changes/ 与 docs/79–81 是否该进主仓

| 路径 | 判定 | 理由 |
|---|---|---|
| `changes/fix-provider-context-window-usage/`（4 文件）、`changes/terminal-path-link-dialog/`（4 文件） | **不进** | OpenSpec 过程产物（proposal/design/tasks 勾选清单）。main 上没有 `changes/` 顶层目录；本仓惯例是结论合入 `docs/` 设计文档（memory：plan-lands-in-docs）。有留存价值的设计内容应并进对应 docs 编号文档。 |
| `docs/79-terminal-path-link-dialog-implementation-prompt.md`（~690 行） | **不进** | 「implementation prompt」= 派工提示词，纯过程产物。若路径链接功能要留设计文档，应重写成设计文档体例。 |
| `docs/80-daily-2026-08-05.md` | **不进** | 个人工作日志（明写「当日新增 4 个功能」「提交分支 dev_zhengjunkj」），不是设计文档。 |
| `docs/81-abnormal-exit-session-recovery.md` | **进** | 冷恢复的设计决策/文案/验收标准，是 #4 的正式设计文档，PR 描述也引用其第 5 节做验收。编号与 main（现到 77）不撞；78 空号可接受或让作者顺移。 |
| `docs/provider-context-window/README.md` | **改造后进** | 内容是正式设计，但目录形态不合惯例（docs/ 下是平铺编号 md），建议改成 `docs/78-provider-context-window.md` 之类。 |
| `.gitignore` 加 `dev.bat`/`build.bat` | 勉强可 | 个人脚本忽略，无害；更干净的做法是放本地 exclude。 |
| `package-lock.json`（335e5325，删「npm 报为冗余」的 optional peer 条目） | **不进，重做** | 与 main 双改必冲突；且删 `@docsearch` 的 optional peer 条目是新版 npm 的 lock 格式行为——本仓纪律是 lock 必须 `npx npm@10` 生成（memory：release-lockfile-npm10）。合并时丢弃该 commit，冲突后用 npm@10 重生成。 |

## 7. 分类结论

**可直接收（解决轻量冲突即可）**
- `82ef428b` 懒加载分片自愈（lazyRetry + 逐 tab ErrorBoundary）——质量高、独立、无 main 冲突。
- `3000d4d9` settings 两开关——serde default + 三层前端回落齐全，测试到位。
- `498744b6` cli-adapter `--settings` 注入——边界与清理都合规；收之前要求作者补一次 Windows 真机 managed 启动验证（空串 reset 语义）并在描述里写明 subagent 模型也被覆盖。

**要作者改后再收**
- `9db6824f` 终端状态栏：①补 `sessions` Map 的会话退出清理（或 LRU 上限）；②settings hint 说明「仅多分屏显示」；③删除死 key `statusBarShow` 或补 show 入口。
- `d7a7c331` 上下文窗口/用量修复：功能对，但合并时需处理 lib.rs / migration 排序摩擦；建议把 `docs/provider-context-window/README.md` 归入编号文档。
- `f6ffe8f1` 主题预设：①colorGuard parity 测试扩展到 4 个 `[data-theme]` 块；②统一 ThemeSection「即时生效 + draft」与 StatusBar「即时保存」两条路径的语义。
- `fec759ca` + `0d246df8` Provider 模型行/复制：**必须基于 main ea8d55d 重做** `ProviderModelsEditor`（在 Radix Select 版上加容量预设与 FieldRow）并把 `LaunchProfilesPanel` 的 option 文案改动搬到 `LaunchProfileBasicsCard.tsx`；另请作者复核「新模型默认 1M」的产品决定（代码注释仍写着 200k，自相矛盾；对 Claude 主流 200k 模型会默认写错窗口，反而制造新的显示偏差——建议默认留空=未知，或跟随预设选择）。duplicateSeed 复用 seed.id 依赖调用方已重新生成 id，建议 FormPanel 内 add 路径一律 `crypto.randomUUID()` 防御。lineRatchet/colorGuard 基线按 main 重算。

**建议拆出去独立 PR**
- `ec20f1f4` 终端路径链接对话框：完整独立 feature（core+daemon+web+tauri+前端 12 个新文件），与本 PR 其余内容零耦合；且有一个需修的 gotcha——`TerminalPathLinkDialog` 调 `openEditor` 未传 `{ forcePaneTab: true }`，Files 视图下点链接会静默无反应（CLAUDE.md 已知坑）。
- `e9821de2` 冷恢复（另一 agent 审查范围，本文只确认：`docs/81` 应随它走，PR 自己也标了「合并前必须 Windows 人工实测」）。

**丢弃/重做**
- `335e5325` package-lock：丢弃，冲突解决后用 npm@10 重生成。
- `changes/**`、`docs/79`、`docs/80`：从 PR 中移除。

**总体**：PR 是 5+6 个异质 commit 的合订本，GitHub 已判 CONFLICTING，Provider UI 部分与 main 的 ea8d55d 是「两侧各自重写同一文件」级别的冲突，机械 rebase 不可行。建议按上面分组拆分：先收 3 个低风险 commit，Provider 两个 commit 重做，路径链接与冷恢复各自独立成 PR。

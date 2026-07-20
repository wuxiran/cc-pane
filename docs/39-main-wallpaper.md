# 主区壁纸：图片 / 视频 / 背景音乐

> 状态：已实施（四阶段全部完成，待验收） | 分支 `feat/wallpaper`，基线 `acc7457`（v0.10.19）

## 实施记录（2026-07-20）

四阶段均已按本文档落地。与文档的偏差与补充：

- **钉死清单最终版**：`MainViewSwitcher.tsx`（panes 容器）、`SplitContainer.tsx`、
  `Panel.tsx`（面板底 + 空状态底 + 点阵 opacity）、`StarredPanel.tsx` 改读
  `--app-panel-bg-effective`；TabBar 自身 transparent、分割条 `.splitview-sash`
  本就透明、DnD overlay 为半透明 accent 色，均无需改；SettingsPanel /
  LayoutTopBar / LayoutSwitcherWindow / OrchestrationFullView 在主区 panes
  根节点之外，不受覆盖影响，保持原样。LayoutTopBar 在 panes 容器内抬 `z-[1]`
  （壁纸层是 positioned z-0，静态流内容会被盖住）。
- **effective 覆盖走 React inline style**（panes 根节点 `--app-panel-bg-effective:
  transparent`），等价于 provider setProperty，随 wallpaperActive 布尔翻转。
- **orbs 压 0 走文档根 token**：orbs 层挂 AppShell（主区外），由
  `MainWallpaperLayer` 副作用在 `document.documentElement` 上置
  `--app-orbs-opacity: 0`，卸载/失活时移除。
- **视频策略表外补充**：`power_saver === "always"` → poster，reason
  `user-power-saver`（表只定义了 never/auto 路径，always 语义按「总是省电」实现）。
- **工作空间 custom 覆盖 UI（阶段 1 范围）**：只支持覆盖壁纸图片本身
  （`enabled/kind/file`），滑杆类参数按逐字段合并语义回落全局；入口挂在
  运行环境 Sheet（`WorkspaceEnvironmentPanel`）底部，即时保存，独立于该面板的
  dirty 快照逻辑。off 按钮文案用「不使用」而非「关闭」，避免与 Sheet 关闭按钮
  同名（含测试选择器碰撞）。
- **音乐 blur 暂停规则复用 `video.pauseWhenUnfocused`**（music 结构无独立字段）。
- **`cargo fmt --all -- --check` 在基线即有漂移**（`cc-cli-adapters/claude.rs`、
  `shared_mcp_service.rs`、`workspace_service.rs`），非本次引入，未顺手修。
> 关联：`docs/19-borrow-cli-manager-features.md:30` F2.2（P0，验收标准已定）、`docs/22-frontend-design-refactor.md:18-33`

## 交付方式

**四阶段，每阶段独立可验收、可提交。** 顺序：静态图 → 终端半透明 → 音乐 → 视频。
视频阶段卡住不影响前三阶段落地。**每完成一阶段就上报一次进度**，不要攒到最后。

范围：整个主区，终端半透明；全局默认 + 工作空间可覆盖。

## ⚠️ 开工第一件事

**全量 grep `--app-panel-bg` / `--app-terminal-bg` / `backdrop-filter`，把所有画不透明底的地方钉成清单。**

已知至少四处（`MainViewSwitcher.tsx:123`、`SplitContainer.tsx:37`、`Panel.tsx:494`、`Panel.tsx:576`），
但 TabBar 毛玻璃、各 tab 容器、`StarredPanel`、分割条、DnD overlay 都可能各画各的。
**这是本任务最可能返工的点**——漏一处就是「图透了一半」，然后反复打补丁。

---

## 架构决策（四阶段共同依赖，先落地）

### 挂载点：`MainViewSwitcher.tsx:120-124` 的 panes 容器

不要挂 `AppShell`（像 `DarkOrbsBackground` 那样）——会铺到 TitleBar/ActivityBar/StatusBar
底下，还得反向遮罩。挂 panes 容器天然随视图切换生效，且该 div 已 `overflow-hidden`，
只需补 `relative`；内容容器补 `relative z-[1]`。

新建 `web/components/layout/MainWallpaperLayer.tsx`，遵循现有装饰层惯例
（`absolute inset-0 z-0 pointer-events-none overflow-hidden` + `aria-hidden="true"`，
参考 `web/components/layout/DarkOrbsBackground.tsx`）。

内部自下而上：媒体层（img/video）→ blur/scale 容器 → dim 遮罩。

### 三层不透明底：新增 effective 变量，不动所有权

**不要删除任何一层的 `background: var(--app-panel-bg)`**——那会破坏 `docs/22:18-33`
的「各区自绘背景」约定，也让亮色/未启用场景回归。

在 `web/assets/index.css` 加一层间接 token（亮暗两套）：

- `--app-panel-bg-effective`（默认恒等于 `--app-panel-bg`）
- `--app-panel-dots-opacity`（默认 0.03，对应 `Panel.tsx:580` 的点阵）
- `--app-orbs-opacity`（`DarkOrbsBackground` 外层，壁纸时置 0——`mix-blend-screen`
  叠在照片上会洗白）
- `--app-wallpaper-dim`

把上述钉死清单里的位置改成读 `--app-panel-bg-effective`。壁纸激活时由 provider 在
**主区根节点**（不是 `:root`，避免污染 files/resources 视图）
`element.style.setProperty("--app-panel-bg-effective", "transparent")`。

好处：`designTokens.test.ts` 只扫 Tailwind 类名正则，CSS 变量不受影响；
亮色/未启用时变量恒等，零行为变化，无需条件渲染。

### 状态：新建 `web/stores/useWallpaperStore.ts`，持有**已解析**结果

**不要**写 `useSettingsStore(s => resolveWallpaper(s.settings, ws))`——每次返回新对象，
撞 CLAUDE.md:294 的 `Maximum update depth exceeded` 崩页。

store 持有扁平字段：`resolved / assetUrl / musicUrl / videoPolicy / musicGestureNeeded`，
在 settings 变更与 selectedWorkspace 变更处调 `recompute()`。组件只做原子字段 selector。

### 跨端门控：`isTauriRuntime()`（`web/utils/desktopRuntime.ts`）

三处：`MainWallpaperLayer` 顶部早退、设置页整块不渲染、`recompute()` 在非 Tauri 下产出 null。
config.toml 字段照写，Web 端不消费。

---

## 数据模型

`WallpaperSettings` 挂 `AppSettings`（`cc-panes-core/src/models/settings.rs:27` 附近），
仿 `ScreenshotSettings`（`:288-293`）风格，但**每个字段都要 `#[serde(default)]`**
（`ScreenshotSettings` 没写；新结构不写的话老 config.toml 反序列化直接失败）。

```
enabled / kind(none|image|video) / file / fit(cover|contain|tile|center)
opacity / blur / dim / terminal_opacity
video { autoplay, playback_rate, pause_when_unfocused, power_saver(auto|always|never) }
music { enabled, file, volume, loop_playback, autoplay }
```

`file` 存 `wallpapers_dir` 下的**相对文件名**，不存绝对路径。

**工作空间覆盖放 `workspace.json`**（不放 settings.toml——壁纸是工作空间的视觉身份，
随迁移/分享更自然）：

```
wallpaper_override: Option<{ mode: "inherit" | "custom" | "off", config: Option<WallpaperSettings> }>
```

**`"off"` 必须与 `"inherit"` 区分**——用户要能在某个工作空间明确关掉全局壁纸。

合并逻辑写纯 TS 函数 `web/utils/wallpaper.ts::resolveWallpaper()`（可独立单测，Rust 只做存储）：
`off` → null；`custom` → 以全局为底**逐字段浅覆盖**（未设字段回落全局，比整体替换更符合预期）；
`inherit`/未设 → 全局；全局 `enabled === false` → null。另加 `clampWallpaper()` 收敛数值到合法域。

`web/stores/useSettingsStore.ts:56-86` 的 `withCCChanSettings()` 要补 wallpaper
**三层嵌套**默认合并（wallpaper / video / music），否则老配置升级后
`settings.wallpaper.video` 是 undefined 直接崩。

---

## 阶段 1：静态图片

### 后端

- `cc-panes-core/src/models/settings.rs` — 新增结构 + Default impl + 挂 `AppSettings`
- `cc-panes-core/src/utils/app_paths.rs` — 加 `wallpapers_dir()`（`data_dir.join("wallpapers")`，
  放 `skills_dir` 附近约 `:122`），并注册进 `ensure_control_center_layout()` 的 dirs 数组（`:178-198`）
- 新建 `cc-panes-core/src/services/wallpaper_service.rs` — `import_wallpaper` / `list_wallpapers` /
  `remove_wallpaper` / `resolve_wallpaper_asset`（安全校验见下）
- 新建 `src-tauri/src/commands/wallpaper_commands.rs` — 命令包装；asset URL 复刻
  `ccchan_service.rs:1578-1586` 的 `file_asset_url()`
- `src-tauri/src/lib.rs` — `invoke_handler` 注册
- **`src-tauri/src/commands/settings_commands.rs:156-272` 的 `migrate_data_dir` 复制清单加
  `wallpapers/`**——原清单只有 data.db / providers.json / workspaces/，不加会**静默丢壁纸**
- `cc-panes-core/src/services/workspace_service.rs` — workspace 模型加
  `wallpaper_override`（`#[serde(default)]`）+ 写入路径

**阶段 1 无需改 `tauri.conf.json`**——`assetProtocol.scope` 已是 `["**"]`（`:28-31`），
CSP 的 `img-src`（`:26`）已含图片。

### 前端

- `web/types/settings.ts` — 镜像类型
- `web/stores/useSettingsStore.ts:56-86` — 三层默认合并
- 新建 `web/utils/wallpaper.ts` + `.test.ts`
- 新建 `web/stores/useWallpaperStore.ts`
- 新建 `web/components/layout/MainWallpaperLayer.tsx`
- `web/components/layout/MainViewSwitcher.tsx:120-124` — 补 `relative`、插入壁纸层、改读 effective
- 钉死清单里的其余位置 — 改读 effective
- `web/components/panes/Panel.tsx:580` — 点阵 opacity 走 token
- `web/components/layout/DarkOrbsBackground.tsx` — 外层 opacity 走 token
- `web/assets/index.css` — 新增四个 token（亮暗两套）
- 新建 `web/components/settings/WallpaperSection.tsx` — 选文件用
  `@tauri-apps/plugin-dialog` 的 `open()`（范例 `web/components/launcher/LauncherInjectionRow.tsx`）；
  fit / opacity / blur / dim 滑杆 + 预览缩略图
- `web/components/SettingsPanel.tsx:23,75,91,307-309` — 五处注册（照 screenshot 写法）
- 工作空间设置入口 — 三态选择 inherit/custom/off
- i18n 双语

---

## 阶段 2：终端半透明（红线邻域，最需小心）

### 核心手法：把开关从构造期挪到主题期

`web/components/panes/TerminalView.tsx:966-983` 构造 xterm 时**无条件**加
`allowTransparency: true`。

**无条件是关键**：若随设置开关，切壁纸就要重建/重刷终端，那直接踩「TerminalView
渲染生命周期」红线。恒开后，开关壁纸只走已有的主题热更新路径（`TerminalView.tsx:1756-1757`
的 `term.options.theme = ...` + `applyTerminalElementTheme`，后者写的是
`element.style.backgroundColor`，接受 rgba 无需改）。

代价：不透明时也有微小 alpha 合成开销。换掉的是生命周期重建，值得。

### 主题侧

`web/components/panes/terminalTheme.ts`：

- **保留 `DARK_TERMINAL_THEME` / `LIGHT_TERMINAL_THEME` 常量不动**——
  `terminalTheme.test.ts:11-19` 有 `toBe` 恒等断言，改了会红
- 新增 `withTerminalBackgroundAlpha(palette, alpha)`：返回新对象，background hex 转 rgba；
  **`alpha >= 1` 时返回原对象引用**（保住上述断言）
- `getTerminalTheme` 加可选第三参 `alpha`

调用点 `TerminalView.tsx:362` / `:1052` / `:1756`。

⚠️ **`:1052` 的 OSC 背景色查询回复必须用不透明原色**——那是回答 CLI「你的背景色是什么」，
回 rgba 会让某些 TUI 解析失败。所以 OSC 路径不传 alpha。`cursorAccent` 同理保持不透明
（否则块状光标下的字符会糊）。

### 渲染器侧

`web/components/panes/terminalRenderer.ts` 的 `decideTerminalRenderer`（`:97-163`）
加透明分支，返回 `{ renderer: "dom", reason: "wallpaper-transparency", webglAllowed: false }`
——WebGL 不透传背景，不覆盖就是黑底。

⚠️ **新分支必须插在 `:146-154` 的 `windows-cjk-guard` 之后**（`:156` 的最终 return 之前），
让 Windows 的 reason 保持 `windows-cjk-guard` 不变——否则现有测试断言与线上诊断基线同时变化，
属「看起来没问题实则污染诊断基线」。同时 `mode === "webgl"` 分支（`:126`）内也要加透明判断
（用户显式选 webgl 也必须被透明需求覆盖）。

`terminalRendererController.ts:295-320` 的 `configure()` **无需改动**——
它已按 `decision.reason` 变化判定 `shouldReconfigure`，会自动 `disposeWebgl` 降 DOM。

还要检查并放开 `.xterm-viewport` / `.xterm-screen` 的底色（xterm 自带样式会给 viewport
上底色，不放开会挡住壁纸）。

### 红线归属（写给 review）

**不触及**渲染生命周期：`allowTransparency` 常量化、主题 alpha 变更、
`applyTerminalElementTheme`、OSC 回复。

**触及渲染器切换（重点 review）**：`decideTerminalRenderer` 新分支 → 可能触发
`configure()` → `disposeWebgl()`。约束：**只允许在用户改设置/切工作空间时发生一次**，
禁止在 resize / visibility / focus 等高频路径重算；禁止引入任何 `term.dispose()` 或组件 remount。

---

## 阶段 3：背景音乐

**唯一必改配置**：`src-tauri/tauri.conf.json:26` 的 CSP 加
`media-src 'self' asset: http://asset.localhost blob: data:`（与现有 `img-src` 同源集合对齐）。

新建 `web/utils/wallpaperMusic.ts`，用 `HTMLAudioElement` 单例——
**不要**用 Web Audio 解码整文件（大 mp3 吃内存）。可参考
`web/utils/notificationSound.ts:15,25-27` 的「单例 + suspended 恢复」写法，但**不共享实例**
（那是合成音，采样率/生命周期不同）。

API：`ensureMusic(url, {volume, loop})` / `play()` / `pause()` / `setVolume()` / `dispose()`。

### 自动播放三层兜底（Tauri WebView 有 autoplay 门槛）

1. 尝试即播，catch `NotAllowedError`
2. **静默手势兜底**：捕获后 `document.addEventListener("pointerdown"|"keydown", retry,
   { once: true, capture: true })`——用户点任何地方（包括点进终端）就起播，多数情况无感
3. **显式入口**：`musicGestureNeeded: true` 时 `web/components/StatusBar.tsx` 出一个音符按钮
   （给「用户一直不点」和「想手动控制」两种情况留口）

暂停规则：`visibilityState === "hidden"` → pause；窗口 blur 按 `pauseWhenUnfocused` 设置；
进入 MiniMode → pause；主视图切走 panes **建议不暂停**（BGM 属全局氛围）。
切工作空间换曲要淡出淡入（`setInterval` 调 volume，约 200ms），避免爆音。

---

## 阶段 4：视频

### 禁区（先划死）

- **禁止独立隐藏 WebView 窗口做壁纸**——CLAUDE.md:291，失效 WebView2 + emit 失败日志
  自放大洪水，实测 13 条/秒烧满 CPU、前端假死
- **禁止 WebGL / canvas 渲染视频帧**——Chromium 每进程约 16 个 live WebGL context 上限
  （`terminalRenderer.ts:48-51` 注释说这是花屏/黑屏根因之一），会与终端渲染器争抢
- **必须用原生 `<video muted playsInline loop preload="metadata">`**（走独立 media pipeline，
  不占 WebGL context）；视频**恒 muted**，声音一律走阶段 3 的独立 audio
  （否则 autoplay 直接被拒）

### 降级策略

新建 `web/utils/wallpaperVideoPolicy.ts`，**照 `decideTerminalRenderer` 的
`{ mode, reason }` 形状**返回可诊断可测的决策（`env` 全部可注入，便于单测）。
判定顺序（先硬后软）：

| 顺序 | 条件 | 结果 | reason |
|---|---|---|---|
| 1 | `power_saver === "never"` | video | `user-force-video` |
| 2 | `prefers-reduced-motion: reduce` | poster | `reduced-motion` |
| 3 | `hardwareConcurrency < 4` 或 `deviceMemory < 4` | poster | `low-end-device` |
| 4 | `getBattery()` discharging && level < 0.3 | poster | `battery-saver` |
| 5 | 视频 `onerror` / codec 不支持 | poster | `decode-failed` |
| 6 | 其余 | video | `auto-video` |

`poster` = 停在首帧静态图。**MVP 不引入 ffmpeg 抽帧**，`poster` 属性缺省时回落纯色 dim 层。

运行时暂停（不改 mode，只 `video.pause()`）：hidden / blur（按设置）/ MiniMode /
主视图切走 panes / 布局中无可见 pane。`playbackRate` 可降到 0.5，是最省事的降负载手段。

---

## 安全校验（照抄 ccchan 范式）

`wallpaper_service.rs::resolve_wallpaper_asset()` 逐条复刻
`src-tauri/src/services/ccchan_service.rs:1421-1465` 的 `resolve_user_spritesheet()`：

1. 只接受 `wallpapers_dir` 下的**相对文件名**；拒绝含 `/` `\` `..` 与 `Path::is_absolute()`
2. **扩展名白名单**（小写化后比对），且**扩展名与 `kind` 必须匹配**（image 配置不能指到 mp4）：
   image `png jpg jpeg webp gif avif` / video `mp4 webm` / audio `mp3 m4a ogg wav flac`
3. `canonicalize()` 后 `starts_with(wallpapers_dir.canonicalize())` 校验未逃逸（防符号链接）
4. **大小上限**：image 32MB / video 512MB / audio 64MB，超限拒绝并返回明确错误
5. ⚠️ **返回给前端造 asset URL 时用未 canonicalize 的路径**——
   `ccchan_service.rs:1463` 明确记了这个坑：Windows canonicalize 产生 `\\?\` 前缀，
   塞进 `http://asset.localhost/` 会 404
6. `import_wallpaper()` 入口也跑一遍校验（校验用户选的源文件），复制时生成
   **受控文件名**（uuid + 原扩展名），不沿用用户文件名——一步消除路径注入面

注释里写清「`assetProtocol.scope` 是 `**` 全放行，安全必须在这里兜」，与 ccchan 同一句话。

---

## 验收

### 每阶段都要跑
- `npx tsc --noEmit`
- `npm run test:run -- --maxWorkers=3`（高负载下 vitest 偶发 fork 超时假失败，重跑再判）
- 涉及 Rust 时：`cargo check --workspace`、`cargo clippy --workspace -- -D warnings`
- **`web/components/designTokens.test.ts` 必须继续绿**

⚠️ `cargo test --workspace` 可能被运行中的 `cc-panes-daemon.exe` 文件锁阻塞
（`os error 32`）。**绝对不要杀用户的进程**，改用 `cargo test -p <crate>` 分 crate 跑，
并在汇报里说明哪些没跑到。

### 新增测试
- `wallpaper.test.ts` — 合并三态（inherit/custom/off）+ clamp 边界
- `terminalRenderer.test.ts` — 透明分支 + **「Windows 下 reason 保持 windows-cjk-guard」回归断言**
- `terminalTheme.test.ts` — `withTerminalBackgroundAlpha`（alpha=1 返回同一引用、alpha<1 产出 rgba）
- `wallpaperVideoPolicy.test.ts` — 覆盖上表 6 条分支
- `wallpaper_service` Rust 单测 — 绝对路径/`..`/白名单外扩展名/符号链接逃逸/超限 全部拒绝；
  合法路径通过且返回**非 `\\?\`** 路径
- `app_paths` 补 `wallpapers_dir` 断言

### 手动验收（不可省）
- **关闭壁纸后界面与改动前像素级一致**（这是回归底线）
- 亮/暗主题各看一遍
- 工作空间 A=custom / B=off / C=inherit 三态表现正确
- 迁移数据目录后壁纸仍在
- **拿一份改动前生成的 `config.toml` 跑一遍**（老配置升级路径，开发机全新配置测不出来）
- 终端透明：背景透出、文字清晰可读；`vim`/`btop` 等全屏 TUI 无重影；
  大量输出滚动（`yes` / `cat 大文件`）无明显掉帧；选区高亮可读；
  OSC 背景色查询的 CLI（delta / bat）配色正常
- 视频：**故意放一个 WebView2 不支持的编码（如 H.265）确认降 poster 而非黑屏**；
  拔电源观察是否降级；最小化观察是否 pause；连切 5 个工作空间不同视频观察内存是否回落

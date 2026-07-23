# 壁纸收尾：补齐被缩范围的两处

> 状态：待实施 | 分支 `feat/wallpaper`（已 rebase 到 main `a94c6b6`）
> 前置：`docs/39-main-wallpaper.md` 四阶段已实施完成

## 背景

`docs/39` 四阶段已落地并通过自动化验收（tsc 干净、36 个相关测试全绿、
`designTokens.test.ts` 继续绿、`wallpaper_service` 15 个安全单测、
`migrate_data_dir` 已加 `wallpapers/`、CSP 已加 `media-src`）。

实施记录里 worker 主动标注了**两处被缩范围**，本任务补齐。

## 任务 1：工作空间 custom 覆盖支持完整参数

**现状**（`docs/39` 实施记录）：工作空间 custom 覆盖**只支持覆盖壁纸图片本身**
（`enabled` / `kind` / `file`），透明度、模糊、暗化、终端不透明度这些滑杆类参数
无法按工作空间覆盖，一律回落全局。

原始需求是「全局默认 + 工作空间可覆盖」，用户预期是整套参数都能覆盖。

**改动**：把 `WorkspaceWallpaperCard`（或工作空间壁纸设置入口）扩展为支持
完整参数覆盖。

关键约束：

- **合并语义不变**——`resolveWallpaper()` 的「以全局为底逐字段浅覆盖」已经支持
  部分字段覆盖，不需要改合并逻辑，只需要 UI 能设置更多字段
- 未设置的字段仍回落全局（这是刻意设计，不要改成整体替换）
- `video` / `music` 两个嵌套对象也要能覆盖，注意嵌套合并
- 复用 `WallpaperSection` 里已有的滑杆子组件，**不要复制一份**
- 入口位置保持现状（运行环境 Sheet 底部，即时保存）
- 「不使用」按钮文案保持不变（避免与 Sheet 关闭按钮的测试选择器碰撞）

## 任务 2：音乐独立的失焦暂停开关

**现状**：音乐的 blur 暂停复用了 `video.pauseWhenUnfocused`，music 结构里没有
独立字段。也就是说用户不能「视频失焦暂停但音乐继续放」——而这恰恰是常见诉求
（BGM 属全局氛围，切走窗口未必想停）。

**改动**：`WallpaperMusicSettings` 加 `pause_when_unfocused: bool` 字段。

关键约束：

- **必须 `#[serde(default)]`**，且默认值应保持向后兼容——现有行为是跟随
  `video.pauseWhenUnfocused`，新字段默认值建议 `false`（BGM 不因失焦暂停），
  但**这会改变现有用户的行为**，请在汇报里说明你选了什么默认值及理由
- `useSettingsStore` 的三层嵌套默认合并要同步（漏了会让老配置 undefined 崩）
- TS 类型镜像同步
- `wallpaperMusicController` 的暂停判定改读新字段
- `WallpaperSection` 音乐子区加对应开关 + i18n

## ⚠️ 通用约束

- 分支 `feat/wallpaper`，**已 rebase 到 main**，包含全部发布修复
  （pubspec / lock / copy-hook / CARGO_TARGET_DIR）——**不要动这些文件**
- **不要做任何 git 写操作**（不 commit、不 push、不 rebase），改动留工作树等验收
- 不要碰 `docs/39` 的既有实施记录，只在本文件追加你的记录
- `cargo test --workspace` 可能被运行中的 `cc-panes-daemon.exe` 文件锁阻塞
  （`os error 32`）。**绝对不要杀用户进程**，改用 `cargo test -p <crate>` 分 crate 跑，
  并说明哪些没跑到

## 验收

- `npx tsc --noEmit`
- `npx vitest run web/utils/ web/components/panes/terminalRenderer.test.ts web/components/panes/terminalTheme.test.ts web/components/designTokens.test.ts --maxWorkers=3`
- `cargo check --workspace`、`cargo clippy --workspace -- -D warnings`
- `cargo test -p cc-panes-core`
- 补测试：
  - `wallpaper.test.ts` 增加「工作空间覆盖滑杆类参数」与「嵌套 video/music 覆盖」用例
  - 音乐独立暂停开关的行为测试
- **老配置升级路径**：构造一份不含新字段的 `config.toml`（模拟老用户），
  确认反序列化不崩且行为符合你选的默认值——**这一条不能只靠 `#[serde(default)]` 存在就认为通过**

## 实施记录（2026-07-20）

### 任务 1：工作空间 custom 覆盖支持完整参数

- **发现并修掉一个使任务 1 无效的底层缺陷**：`WorkspaceWallpaperOverride.config`
  原本是 `Option<WallpaperSettings>`，而 `WallpaperSettings` 每个字段都带
  `serde(default)`。前端发一个部分覆盖（如只有 `enabled/kind/file`），经
  `update_workspace(workspace: Workspace)` 的 serde 反序列化后会被**补成完整对象**，
  再 `to_string_pretty` 全量写回 workspace.json。也就是说「未设字段回落全局」在
  第一次保存后就永久失效，custom 实质变成「用 Rust 默认值硬钉住」。
  合并语义（`resolveWallpaper`）本身没动，改的是持久化层能否表达「未设」：
  新增 `WallpaperOverrideConfig` / `WallpaperVideoOverride` / `WallpaperMusicOverride`
  （`cc-panes-core/src/models/settings.rs`），全字段 `Option` +
  `skip_serializing_if = "Option::is_none"`，`workspace.rs` 的 `config` 改用它。
  老 workspace.json 里旧代码写出的完整对象仍能读入（有测试覆盖）。
- TS 侧新增 `WallpaperOverrideConfig` 类型（`web/types/workspace.ts`）镜像之，
  嵌套 `video`/`music` 各自是 `Partial<...>`——原来是 `Partial<WallpaperSettings>`，
  嵌套字段没法只覆盖一个（旧测试里那句 `as never` 就是这个类型缺口的痕迹，已去掉）。
- 滑杆抽成共用组件 `web/components/settings/WallpaperSliderRow.tsx`，
  `WallpaperSection` 与 `WorkspaceWallpaperCard` 共用，未复制第二份。
- `WorkspaceWallpaperCard` 的 custom 区新增三组参数覆盖：
  透明度/模糊/暗化/终端不透明度、video（自动播放/失焦暂停/播放速度/省电策略）、
  music（启用/音量/循环/自动播放/失焦暂停）。**每项一个「覆盖此项」勾选框**：
  不勾 = 字段不写进 config（回落全局，控件禁用并显示全局值），勾上才写。
  这是把「未设字段回落全局」在 UI 上显式化，而不是让滑杆隐式钉死所有值。
- 滑杆拖动走本地草稿 + 300ms 防抖落盘，避免每一步都打一次 `saveWorkspace`。
- 入口位置（运行环境 Sheet 底部）与「不使用」按钮文案均未改动。

### 任务 2：音乐独立的失焦暂停开关

- `WallpaperMusicSettings` 新增 `pause_when_unfocused: bool`，`#[serde(default)]`。
- **默认值选 `false`，理由**：这个字段存在的意义就是把 BGM 从视频的暂停规则里解绑
  （spec 的原话是「BGM 属全局氛围，切走窗口未必想停」）。默认 `true` 等于把旧的
  耦合行为再固化一遍，新开关就只剩「关掉」一个有意义的方向，等于没解耦。
  **代价要说清楚：这确实改变现有用户行为**——之前音乐跟随 `video.pauseWhenUnfocused`
  （默认 true）在失焦时暂停，升级后默认不再暂停，想要旧行为需手动勾上新开关。
  只影响音量策略、不丢数据、一个开关可逆，所以按「新语义正确」而非「行为不变」取舍。
- `wallpaperMusicController` 的 blur 判定改读 `music.pauseWhenUnfocused ?? false`
  （抽成 `musicPausesOnBlur()`，`shouldPlayNow` 与 blur 监听共用），不再读 video 的。
- `useSettingsStore.DEFAULT_WALLPAPER_SETTINGS.music`、`utils/wallpaper.ts`
  的 `DEFAULT_WALLPAPER.music`、TS 类型、`web/test/utils/testData.ts` 同步加字段。
- `WallpaperSection` 音乐子区加开关 + 中英 i18n（`wallpaperMusicPauseUnfocused`
  及提示语），工作空间覆盖里也可单独覆盖此项。

### 验收结果

| 项 | 结果 |
|----|------|
| `npx tsc --noEmit` | 干净 |
| `npx vitest run web/utils/ web/components/ web/stores/` | 218 文件 / 2217 测试全绿 |
| `cargo check --workspace` | 干净 |
| `cargo clippy --workspace -- -D warnings` | 干净 |
| `cargo test -p cc-panes-core` | 720 passed |
| `cargo test -p cc-panes-api / -web / -daemon / cc-panes` | 全绿（本次未触发 daemon 文件锁） |

新增测试：

- `web/utils/wallpaper.test.ts`：滑杆类参数整套覆盖、部分覆盖时其余回落全局、
  嵌套 music 逐字段覆盖、覆盖 video 单字段不整块替换、video/music 两个
  `pauseWhenUnfocused` 互不影响、覆盖值同样被 clamp。
- `web/utils/wallpaperMusicController.test.ts`（新文件）：默认失焦不暂停、
  开关打开后失焦暂停、`video.pauseWhenUnfocused=true` 不再牵连音乐、
  未解析出壁纸时按 false 处理。
- `cc-panes-core/src/models/settings.rs`：老 config.toml 缺 `music.pauseWhenUnfocused`
  的反序列化、部分覆盖 round-trip 后未设字段仍缺席、完整参数覆盖、
  老 workspace.json 的完整 config 仍可读入。
- `cc-panes-core/src/services/settings_service.rs`：**端到端老配置升级路径**——
  写一份不含新字段的真实 config.toml 到临时目录，经 `SettingsService` 加载。
  这条测试第一版是**红的**，暴露了一个只看 `#[serde(default)]` 绝对发现不了的坑：
  `load_from_file(...).unwrap_or_default()` 会把解析失败静默吞成全默认，
  所以断言必须同时检查老配置里的**其它**值（language / opacity / music.file）
  真的被读到了，否则「wallpaper 字段是默认值」会被误判成通过。

### 追加：dev 实测暴露的三处壁纸缺陷（docs/39 遗留）

用户在 dev 实测时发现「blur 调到 0 壁纸still 模糊」，顺藤摸出三处相关缺陷，一并修了。

**1. 面板玻璃模糊糊在壁纸上，壁纸的 blur 滑杆管不到**

`Panel.tsx:495` 无条件加 `backdrop-filter: blur(var(--app-glass-blur))`（暗色 12px）。
平时面板有不透明底色，backdrop-filter 背后没东西可糊；但壁纸激活时
`MainViewSwitcher.tsx:131` 把 `--app-panel-bg-effective` 覆盖成 transparent，
面板一透明，它自己那层 12px 就**直接糊在壁纸上**——视频会被糊没，
而壁纸的 `blur` 滑杆只控制壁纸层自己的 `filter`，两层完全独立。

改为可配置：`WallpaperSettings` 新增 `glass_blur: f64`（0..=24，`#[serde(default)]`，
默认 **0**），壁纸激活时在 panes 根节点接管 `--app-glass-blur`。默认 0 = 壁纸之上
不再叠玻璃模糊；想要磨砂自己调上去。全局与工作空间覆盖两处都有滑杆。

**2. 终端底色被画了两层**

`terminalOpacity` 的 rgba 同时被外层容器（`TerminalView.tsx:2201`）和 xterm 元素
（`applyTerminalElementTheme` + 构造时的 `theme`）各画一遍，0.3 叠 0.3 实际 ≈ 0.51，
视觉上「隔了两层」，且 terminalOpacity 永远到不了真正的全透明。

新增 `withTransparentTerminalBackground()`：底色归外层容器独占，xterm 侧 background
一律 `rgba(0,0,0,0)`。`alpha >= 1`（壁纸未激活）返回原对象引用，零行为变化。

**3. terminalOpacity 下限从 0.3 放宽到 0**

有了 1 和 2，0 才是真的全透明——字直接浮在视频上。Rust clamp、TS clamp、
两处滑杆 min 同步改。0.3 这个旧下限本来就是被双层叠加逼出来的保守值。

三处都补了测试：`terminalTheme.test.ts` 三例（xterm 侧全透明 / alpha>=1 恒等引用 /
terminalOpacity=0）、`wallpaper.test.ts` 的 glassBlur 默认值与覆盖、clamp 边界，
Rust 侧 glass_blur 收敛与 terminal_opacity=0 合法性。

⚠️ **glassBlur 要持久化必须重启 dev**：新字段在 Rust 结构里，旧后端二进制会把
前端发来的 `glassBlur` 当未知字段丢掉，值存不进 config.toml。前端 HMR 只是让
默认值 0 立刻生效（所以视频当场就清楚了）。

建议往 CLAUDE.md 的 Known Gotchas 加一条：**任何 `backdrop-filter` 面板叠在壁纸上
都会绕过壁纸自己的模糊设置；任何半透明底色都要确认只有一层在画**。

### 追加：视频自带音轨当 BGM + 两个滑杆改名

**视频音轨当 BGM**（`music.use_video_audio`，`#[serde(default)]` 默认 false）

实现走**独立 audio 元素喂同一个文件**，不给 `<video>` 解除静音。理由：
浏览器对有声 video 的 autoplay 策略严格得多，`play()` 会被拒 → 整个视频停在首帧
（现在能自动播正是因为 muted）；且省电策略一暂停视频，声音就跟着断。
独立 audio 能复用音乐已有的手势兜底 / 音量 / 循环 / 独立失焦暂停。
代价是同一文件被 video 与 audio 各解一次、音画会漂移——BGM 场景可接受。

判定逻辑抽成纯函数 `resolveMusicSource()` 放进 `utils/wallpaper.ts`（store 的
`recompute` 混着 Tauri 调用，那段分支不好覆盖）。`useVideoAudio` 只在 `kind=video`
时成立：图片壁纸没有音轨，此时回落 `music.file`，避免勾了开关就彻底没声且找不到原因。

**两个滑杆改名**（纯 i18n）

`不透明度`→`壁纸浓度`、`终端不透明度`→`终端底色浓度`，各加一句方向说明。
起因是用户连续两次把两条一起拉到最左：两者名字几乎一样但方向相反——
前者调低是壁纸变淡，后者调低是壁纸变清楚。这是命名缺陷不是用户失误。

### 收尾复验（2026-07-22，含未提交的「追加」改动）

上面「验收结果」表跑在任务 1/2 落盘（commit `337ef25`）时；三段「追加」改动
（glassBlur / 终端双层底色 / terminalOpacity 放宽到 0 / 视频音轨当 BGM / 两滑杆改名）
当时留在工作树未提交。本次对**含全部追加改动的当前工作树**整体复验：

| 项 | 结果 |
|----|------|
| `npx tsc --noEmit` | 干净 |
| `npx vitest run web/utils/ web/components/panes/terminalRenderer.test.ts terminalTheme.test.ts designTokens.test.ts --maxWorkers=3` | 16 文件 / 188 测试全绿 |
| `cargo check -p cc-panes-core` | 干净 |
| `cargo clippy -p cc-panes-core -- -D warnings` | 干净 |
| `cargo test -p cc-panes-core` | 722 passed（较提交时 720 多出 glass_blur 两例） |

- **`cargo check/clippy --workspace` 无法整跑**：运行中的 `cc-panes-daemon.exe`
  持有文件锁，`cc-panes`（src-tauri）build script 复制该二进制时 `os error 32`。
  按通用约束不杀用户进程，改分 crate 跑。**src-tauri crate 未能编译验证**——但本任务
  工作树里唯一的 Rust 改动是 `cc-panes-core/src/models/settings.rs`（新增 `glass_blur`），
  src-tauri 源码零改动、仅通过 core 依赖间接引用，core 编译通过即无接口断裂风险；
  待 daemon 释放锁后可补一次 `cargo check --workspace` 确认。

### 未做

- 手动/视觉验收（像素级对比、可读性、H.265 降级）按 spec 不在范围内。
- 未新增 Rust 侧的壁纸数值 clamp（覆盖值的收敛仍只在前端 `clampWallpaper`，
  与 docs/39 现状一致，未扩大范围）。
- 未做任何 git 写操作，全部改动留工作树等用户验收（按通用约束）。

## 不做

- 手动/视觉验收（像素级对比、文字可读性、H.265 降级）由用户在 dev 实测，不在本任务范围
- 不要扩大到 `docs/39` 之外的新功能

# 41 — 0.10.20 卡顿调查(交叉分析简报)

> 状态:调查中。本文由 Claude(leader)起草初步分析,交由 Codex(WSL,只读)交叉验证。
> Codex:请阅读本文与相关源码后,把结论**追加**到文末「Codex 分析结论」小节。**不要修改任何代码。**

## 背景

用户反馈:更新到 0.10.20 后应用整体明显卡顿。0.10.19 → 0.10.20 的主体改动是壁纸系统(commit `47d0e75`、`e490c19`、`86c8ca7`),包括:主区图片/视频壁纸、壁纸模糊、玻璃模糊可配(glass_blur 接管 `--app-glass-blur`)、终端底色单层化(xterm 侧全透明)、视频音轨作 BGM。

## Claude 的初步分析(待验证)

嫌疑按大小排序:

1. **壁纸层全屏实时高斯模糊**:`web/components/layout/MainWallpaperLayer.tsx:110` 对壁纸容器挂 `filter: blur(Npx)` + `transform: scale(1.06)`。视频壁纸时每帧解码 + 全屏模糊 + 合成,逐帧持续发生。
2. **大量 backdrop-filter 表面叠在动态内容上**:TitleBar / Sidebar / ActivityBar / StatusBar / 每个终端 Panel(`web/components/panes/Panel.tsx:495`)都有 `backdrop-filter: blur(var(--app-glass-blur))`。暗色主题默认 12px(`web/assets/index.css:310`)。0.10.20 把面板背景改透明(`MainViewSwitcher.tsx:133` 的 `--app-panel-bg-effective: transparent`)后,这些模糊真正糊到壁纸上;视频每帧更新会使所有 backdrop 区域重新计算,分屏越多越贵。
3. **终端透明化 + DOM 渲染器**:Windows 上 xterm 用 DOM 渲染器(WebGL 有 CJK 花屏问题,见项目约定),终端底色单层化后每次滚动都与壁纸层重新合成。

## 假设 B(用户提示"也可能不是壁纸"后补充):Windows Local History 轮询扫描器

`8215d7c` 把 Windows 的 Local History 监视从 ReadDirectoryChangesW 换成了轮询扫描
(`cc-panes-core/src/services/history_scanner.rs`),每项目每 2 秒一轮
(`constants.rs::POLL_SCAN_INTERVAL_MS = 2000`),`read_dir` 递归遍历 + 用
`ignore_patterns` 剪枝。仅 Windows 启用——正好对应用户平台。

Claude 复核发现的疑点:

- **剪枝模式是根锚定的**:`history_service.rs::matches_pattern` 对 `node_modules/**`
  只匹配 `node_modules` 与 `node_modules/...`,**嵌套目录不命中**——monorepo 里
  `packages/foo/node_modules`、`frontend/node_modules` 等整棵被扫描,几万到几十万
  文件每 2 秒全量 stat 一轮。用户注册了大量 pnpm/vben monorepo 项目。
- 默认剪枝清单只有 `node_modules/target/dist/build/.git/.ccpanes` 六个目录,
  `.venv`、`.next`、`coverage`、`.turbo`、flutter 的 `.dart_tool` 等都不在内。
- **watcher 启动范围已查实**:`web/components/Sidebar.tsx:97-101` 应用启动时对**所有
  工作空间的所有项目**调用 `initProjectHistory`(该用户注册了 120+ 项目);
  `useOpenTerminal.ts:108` 开终端也会 init。`history_service.rs:456-470` 在 Windows
  下每项目起一个独立 `scanner_loop` 线程 → **120+ 线程各自每 2 秒全量扫一轮**,
  且每轮还 `read_config` 重读一次项目配置文件。
- **用户已确认壁纸未开启**,假设 A 基本排除,假设 B 是当前主嫌疑。

## 请 Codex 验证 / 补充的问题

1. 复核以上三条嫌疑在代码里是否成立,指出我看漏或说错的地方。
2. **壁纸未启用时**是否也有新增开销?(即 0.10.20 相比 0.10.19,壁纸关闭状态下渲染路径有无变化——用户没说明是否开了壁纸,若未开启也卡,上述分析全部不成立,需要另找原因。)
3. 检查 `useWallpaperStore` / `MainViewSwitcher` / `TerminalView` 的订阅与重渲染路径:壁纸相关 state 变化是否会导致终端组件不必要的 re-render?
4. 视频音轨 BGM(独立 audio 元素喂同一文件)是否意味着同一视频被解码两次?
5. 检查这三个 commit 里壁纸之外的改动(如 settings 模型、terminalTheme)有无性能回归可能。
6. 逐条核实假设 B:watcher 启动范围与线程数、根锚定剪枝对嵌套 node_modules 的遗漏、
   每轮扫描的实际开销量级;并判断假设 A(壁纸渲染)与假设 B(轮询扫描)哪个更可能是
   用户"更新后整体很卡"的主因(注意壁纸需要用户手动开启,轮询是无条件启用)。
7. 给出缓解与修复建议的优先级排序(用户侧止血 + 工程侧修复),分别覆盖两个假设。

## Codex 分析结论

(Codex 在此追加)

### 核实口径

- 静态核对对象是 tag `v0.10.20`（`681c803`）及其中的 `47d0e75`、`e490c19`、
  `86c8ca7`、`8215d7c`，运行态对象是 Windows 已安装并正在运行的
  `cc-panes.exe 0.10.20`。release 配置已确认 `[wallpaper] enabled = false`、
  `kind = "none"`。
- 分析过程中 main 于 2026-07-23 20:09 新增 `a5cc195`，完整 revert 了
  `8215d7c`。因此当前工作树已经没有轮询扫描器；下面对假设 B 的源码分析以
  **已发布且仍在运行的 0.10.20** 为准。该 revert 尚未改变已启动进程，必须发布并
  重启应用才会生效。

### 1. 三条壁纸嫌疑复核

1. **全屏 CSS blur 条件成立，但只在壁纸实际激活且 `blur > 0` 时成立。**静态图片
   不会逐帧重算；视频壁纸才会形成“视频逐帧更新 + 全屏 filter + 合成”的持续 GPU
   压力。当前壁纸关闭，`MainWallpaperLayer` 在创建任何 `img/video` 前即返回 `null`，
   所以此项不是本次现场原因。
2. **“所有 backdrop-filter 都在糊视频、默认 12px”说得过重。**壁纸层只挂在 panes
   主区，不铺到 TitleBar / ActivityBar / StatusBar，也不在作为兄弟节点的 Sidebar
   后面；这些区域不会因为主区视频而逐帧重算。真正覆盖壁纸的是各 `Panel`，但
   0.10.20 在壁纸激活时把主区 `--app-glass-blur` 覆盖为壁纸设置值，而新配置默认
   `glassBlur = 0`，不是暗色根变量的 12px。只有用户主动把 `glassBlur` 调大时，
   多 Panel backdrop 才是显著的二次开销。
3. **Windows auto 模式用 DOM renderer 成立，但这不是 0.10.20 新增行为。**
   `terminalRenderer.ts` 的 `windows-cjk-guard` 在壁纸功能前已使 Windows auto 走 DOM。
   壁纸激活且 `terminalOpacity < 1` 时，透明终端会增加滚动/合成成本；壁纸关闭时
   alpha 恒为 1，`getTerminalTheme` 和 `withTransparentTerminalBackground` 都返回原
   不透明主题，未切透明底色。

### 2. 壁纸关闭时的新增开销

关闭时没有媒体解码、CSS blur、dim 遮罩、panes token 覆盖或背景音乐播放。新增的
常驻工作只剩：壁纸 store 的低频订阅、返回 `null` 的 `MainWallpaperLayer`、几个原子
selector 和 memo。唯一真正改变终端构造路径的是 `allowTransparency: true` 被无条件
开启；即使主题最终不透明，这可能有微小的合成成本，值得后续 A/B benchmark，但其
量级不足以解释本次几十核持续忙碌。`Panel` 原有 backdrop-filter 仍在，关闭壁纸时
背景/token 与 0.10.19 等价。

### 3. Store 订阅与终端重渲染

- `MainViewSwitcher` 只订阅 `wallpaperActive: boolean` 和 `glassBlur: number`；
  `TerminalView` 只订阅最终的 `terminalOpacity` 数值（未激活恒为 1）；音乐播放状态
  只由 StatusBar 消费。因此 `musicPlaying`、手势状态等不会扇出重渲染终端树。
- `recompute()` 只在 wallpaper settings 引用变化、工作空间列表/选择变化时运行，
  没有 timer、RAF 或视频逐帧 setState。关闭壁纸时它在解析后直接把结果置空，不做
  asset IPC。工作空间对象整体变化会让壁纸层重算一次，但 selector 的最终原始值不变
  时不会触发 `TerminalView`。
- 开关壁纸或修改 `terminalOpacity` 会让每个已挂载 `TerminalView` 各渲染一次、热更新
  theme/renderer；这是低频且符合功能需要，没有发现持续性无效 re-render 链。

### 4. 视频音轨 BGM 是否双重解码

同一 URL 确实同时交给一个 muted `<video>` 和独立 `HTMLAudioElement`，会建立两个媒体
管线，文件读取/缓存访问与 demux 至少发生两次。不过“视频被完整解码两次”不准确：
`video` 负责视频帧，`audio` 通常只选择音轨，后者不会再解码一遍视频帧；muted video
也可能跳过音频解码。额外成本主要是第二次 demux + 音频解码，并且只有“视频壁纸已
激活 + 音乐开启 + `useVideoAudio=true`”才存在。当前壁纸关闭时不存在此开销。

### 5. 三个壁纸 commit 及 0.10.20 其余改动

三个 commit 修改的运行时代码均服务于壁纸：settings/workspace 模型补字段及校验只在
配置读写时执行；wallpaper asset 校验只在设置/工作空间变化时执行；`terminalTheme`
在 alpha=1 时刻意返回原对象。未发现另一个无条件高频循环。需要保留为次要疑点的只有
上述无条件 `allowTransparency: true`，建议单独 benchmark 后决定是否优化。

完整 `v0.10.19..v0.10.20` 还包含 provider 枚举序列化、粘贴时重置 IME guard 和发布
元数据/lockfile 改动，均是加载期或事件触发，不形成全局轮询。与壁纸无关且真正改变
常驻运行态的是 `8215d7c` 的 Windows Local History 扫描器。

### 6. 假设 B 逐条核实与主因判断

**启动范围/线程数：成立，并有两个补充问题。**Sidebar 在 load workspaces 后遍历所有
workspace 的所有 project，不区分选中、隐藏、pinned 或是否开过终端；默认 Local
History `enabled=true`。当前 release 数据有 31 个 workspace、133 个 project 引用、
129 个唯一 project path。Windows 每次 `start_watching` 都先 `std::thread::spawn`，
然后才按路径插入 `watchers` map，所以稳态大致是每个成功初始化的唯一路径一个 OS
线程，而不是每次调用永久新增一个；但它并非注释所称的幂等，重复 init 仍会先起新
线程再 drop 旧 handle。

更重要的是，stop 标志只在每轮扫描前的分段 sleep 中检查，`scan_project()` 递归期间
完全不检查。故“drop 后 <=200ms 退出”只在睡眠阶段成立；大仓扫描中重复 init，旧线程
会与新线程重叠直到旧扫描走完。`useOpenTerminal` 每次开终端又 init 一次，会触发这种
不必要的替换和重新建基线。

**根锚定剪枝：成立。**`matches_pattern("packages/foo/node_modules", "node_modules/**")`
为 false，只有根下 `node_modules` 命中；`target/dist/build/.ccpanes` 同理。`.git` 另有
硬编码跳过。默认未覆盖 `.venv/.next/.turbo/.dart_tool/coverage/.cache` 等。因此大型
monorepo 的嵌套依赖/产物会进入扫描。

**每轮成本：比“每 2 秒固定一轮”稍有区别，但风险判断不变。**实现是“先 sleep 2 秒，
再完整扫描”，实际周期为 `2 秒 + 本轮扫描耗时`，同一线程不会自行重叠。每个未剪枝
目录都做 `read_dir/file_type`，每个文件还做 `metadata(modified,len)`、路径字符串转换并
插入新 HashMap；随后对新旧两份快照做 O(N) diff。扫描期间同时持有 prev/next 两份
快照，CPU、随机元数据 I/O 和内存均为所有项目文件数的线性量级。每轮还先重读项目
config；若 `enabled=false` 会跳过目录扫描，但线程仍每 2 秒醒来读一次配置。

Windows 现场采样给出了决定性量级证据：0.10.20 主进程启动约 15 分钟后仍有 216 个
线程，其中 120 个现存线程集中创建于 workspace 初始化时段（与项目量吻合）；5.02 秒
内主进程累计消耗 143.656 CPU 秒，即约 **28.6 个逻辑核持续忙碌**，在 32 逻辑核机器
上约为 **89% 整机 CPU**；Working Set 约 1627 MB、Private Memory 约 1636 MB。同一时段
daemon/web 子进程近乎空闲。该采样不是逐函数 profiler，但“壁纸确认为关闭 + 线程数与
项目数吻合 + 主进程几十核持续忙 + 版本差异中只有扫描器是无条件高频任务”的证据链
已足以把假设 B 判为本次“更新后整体很卡”的主因，置信度高。假设 A 只可能是用户今后
主动开启视频/blur/透明终端后的叠加因素，不是当前主因。

### 7. 缓解与修复优先级

**用户侧止血：**

1. P0：安装包含 `a5cc195` revert 的 hotfix 并**完全退出后重启**；hotfix 未发布前可
   回退 0.10.19。仅关闭壁纸无效，当前本来就是关闭状态。
2. P1：无法换版本时，临时把项目 Local History 配置设为 `enabled=false`，随后重启以
   避免正在进行的旧扫描继续跑；或者临时减少 workspace 中注册的项目。把 workspace
   设为 hidden/pinned 不会止血，因为 Sidebar 不过滤它们。
3. P2（假设 A）：需要壁纸时优先静态图片，`blur=0`、`glassBlur=0`、
   `terminalOpacity=1`；避免视频音轨 BGM。当前壁纸已关闭，无需再调这些参数。

**工程侧修复：**

1. P0：先发布当前 revert，恢复 0.10.19 的运行性能；Windows 目录句柄问题作为独立
   缺陷重新设计，不应让无界轮询进入 release。
2. P1：watcher 改为按“当前/已打开项目”惰性启动并提供全局 Local History 开关；在
   spawn 前原子去重，扫描递归中加入 cancellation。默认忽略规则必须支持任意深度目录
   basename，并补齐常见依赖/产物目录。
3. P1：若必须轮询，改为单 scheduler + 有界 worker pool，限制同时扫描数，错峰/jitter，
   按项目规模自适应退避；不能再一项目一线程同时起跑。缓存配置并增加每项目扫描耗时、
   文件数、跳过目录数、总扫描 CPU/队列长度的诊断指标。
4. P2（假设 A）：对 `allowTransparency=true` 做 wallpaper-off A/B benchmark；视频壁纸
   禁止或限制实时 CSS blur，优先预模糊静态资源/poster；保持 `glassBlur=0` 默认，并对
   双媒体管线、视频分辨率和多 Panel 场景建立 GPU/帧率回归基线。

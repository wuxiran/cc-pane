# 54. CLI TUI 背景行为对照档案（壁纸兼容预检框架）

> 2026-07-24。起因：壁纸模式下 opencode 整屏不透明（用户实机反馈）。经两轮源码级调查（opencode v1.18.4 快照 `../references/opencode`、codex rust-v0.145.0 快照 `../references/codex`），沉淀为各家 CLI 背景模型的对照档案与新 CLI 接入预检清单。CC-Panes 侧机制回顾：容器画半透明底色、xterm 默认背景 cell 全透明、**显式 SGR 48 背景 cell 不透明**（`terminalTheme.ts` / `TerminalView.tsx`）。

## 1. 调查结论对照表

| 维度 | opencode (1.18.4, opentui/SolidJS) | codex (0.145, ratatui/inline) |
|---|---|---|
| 渲染栈 | TS + opentui 0.4.5（原生渲染器） | Rust + ratatui + crossterm |
| 屏幕模式 | 全屏 alt-screen | **inline viewport 为主**，alt-screen 仅覆盖层（transcript/diff/审批弹窗），`[tui] alternate_screen=never` 可全关 |
| 根背景 | **根容器全屏铺 bg**（`app.tsx:1088` + `renderer.setBackgroundColor`）——不透明基底 | **无全屏铺色**；主区/composer/状态栏零 `.bg(` |
| 默认主题背景 | `opencode` 主题 `darkStep1=#0a0a0a` → 全屏 `48;2;10;10;10` | 无 UI 主题概念（`[tui] theme` 只管代码块语法高亮） |
| 终端探测 | `system` 主题靠 `renderer.getPalette`（调色板查询） | 启动探针 OSC 10/11（+CSI 6n/?u/c），100ms 超时，焦点回归重查 |
| **探测失败回退方向** | **回退不透明**（`theme.tsx:159-178` 显式 `setStore("active","opencode")`）——我们踩的坑 | **回退更透明**（`default_bg()=None` → 用户消息块不铺 bg，accent 退 Cyan） |
| 显式 SGR 48 面 | 全屏 + 组件 | 仅三处局部：用户消息/plan 块（**且 gated 在 OSC 11 探测成功**）、diff 增删行、菜单选中行 |
| 透明开关 | 无 env/flag；仅主题系统（`"none"`→alpha0，`theme/index.ts:246`）；上游 #8403 的 Ctrl+P 开关**从未合并** | 无（#14661 无落地痕迹） |
| 升版突然铺色风险 | 已现实发生（palette 探测静默回退） | **低**（需上游引入根 bg 或默认 UI 主题才会变） |

## 2. 已实施与候选干预

**opencode（已实施/在途）**：
- ✅ 适配器 theme 版本兼容双通道注入（legacy `opencode.json` + 新版 `tui.json`/`OPENCODE_TUI_CONFIG`），尊重用户已配 theme（`cc-cli-adapters/src/opencode.rs`，commit 3505ff6/14efa70）。
- 🚧 v3（在途）：**自定义透明主题 `themes/ccpanes.json`（`background:"none"`）绕过 palette 探测**——`none` 走 `resolveColor→alpha0` 不经探测、无回退路径。若 PTY 对照实验仍见铺色 → 命中 opentui 原生合成层（#805 族），上游阻塞，止损。
- 注意项：项目 `.opencode` 配置的 theme 优先级高于 env 注入（上游测试锁定的行为）；`{state}/kv.json` 的 `theme` 键是命令面板持久化位。

**codex（候选，待拍板）**：
- C1：适配器注入 `[tui] alternate_screen="never"`（或 `--no-alt-screen`）——覆盖层改走 inline，绕开"剥离器剥 `?1049h` 后 `terminal.clear()` 清主缓冲区可视区"的交互风险（当前主要风险点）。
- C2：壁纸激活时对 codex **拒答 OSC 11** → 用户消息/plan 块不再 blend 铺色，透明更彻底；代价：明暗判定退化（accent 固定 Cyan）。按 CLI+壁纸双条件收窄（机制同 opencode plan 方案 B 设计）。

## 3. 新 CLI 接入预检清单（壁纸兼容五问）

接入任何新 CLI（grok/kimi/glm/cursor…）时按此预检：

1. **全屏还是 inline？** 进不进 alt-screen、有没有关闭开关（决定剥离器策略）。
2. **有没有根容器全屏铺 bg？** PTY 抓包 grep `\x1b[48;`，看是局部还是铺满。
3. **终端探测机制是什么？**（OSC 10/11 / OSC 4 palette / COLORFGBG / 不探测）——我们的 `terminalOscColor.ts` 应答会如何影响它。
4. **探测失败回退向哪边？**（透明 or 不透明）——**回退不透明的必出事**，提前找主题/配置干预点。
5. **主题/背景配置面在哪？**（config 字段 / env / KV / 主题文件目录）——确定适配器注入通道与"尊重用户已配"判定点。

## 4. 教训（与既有纪律的呼应）

- **第三方 TUI 的静默降级与 Codex resume 捕获链失效（docs/45-codex-resume）是同一物种**：依赖探测的功能失败时静默回退、对用户不可见。我们自己的产品红线"降级必须可见"再添一条反面素材。
- **核验依据必须对齐装机版本 tag，不能看 master**：v1 修复按新版机制实施、装机 1.4.0 不认，白做一轮。
- 上游 issue 索引：opencode #4044/#8403(未合并)/#8467(system 透明)/#12184/#21397/#23573、opentui #805/#922、codex #14661。

# 73 · 终端显示错乱 与「刷新终端显示」失效

> 状态：**调查完成，部分已修**
> 触发场景：Claude/Codex 窗格里粘贴长文本（尤其中文）或图片后，输入框与底部提示行互相重叠、漏出转义碎片；右键「刷新终端显示」点了没反应。
> 关联：`docs/71-multi-pane-resource-contention.md`（卡顿的三类判据 + 输出洪水链路）、`docs/46-frontend-styleguide.md`

---

## 1. 三个症状，两条独立的链

用户一次报了三件事，它们**不是同一个 bug**：

| 症状 | 所在层 | 根因 | 本文 |
|------|--------|------|------|
| **A. 画面重叠/错乱** | xterm **buffer** | 我们主动剥掉 alt-screen（第 2 节） | ✅ 主题 |
| **B. 右键「刷新终端显示」无效** | xterm **renderer** | 菜单只作用于渲染层，修不了 A；且 Windows 上近乎空操作（第 3 节） | ✅ 主题 |
| **C. 页面卡顿** | 前端渲染线程 | 后台标签页不暂停输出（属 docs/71 B 类） | → docs/71 §3 |

**同形陷阱**：A 和 B 会互相伪装。用户看到"乱了"→ 点"刷新"→ 没反应 → 自然得出"刷新功能坏了"。实际是**刷新功能修的根本不是那一层**——B 不是 A 的失败修复，两者是独立缺陷，需要分别修。

判据：
- 错乱内容**能被选中复制出来**（说明 buffer 里就是错的）→ A 类，渲染层任何操作都救不了
- 错乱是**色块/黑块/字形碎片**、选中复制出来是正常文本 → 渲染层（WebGL atlas），才是「刷新终端显示」的目标场景

---

## 2. A 类：alt-screen 被主动剥离

### 2.1 现状

`web/components/panes/terminalBufferMode.ts:138-142`：

```ts
const NORMAL_BUFFER_CLI_TOOLS = new Set(["claude", "codex"]);
```

对 claude / codex，`createTerminalDataRenderer` 会把 PTY 输出流里的 `\x1b[?1049h` / `1047` / `47`（进入/退出备用屏）**整段剥掉**（`ALTERNATE_BUFFER_MODES`，同文件 `:13`），让 TUI 输出留在主缓冲区。

这个设计本身是有意为之，收益明确：**保住滚动历史**。alt-screen 退出后内容会被终端整体丢弃，而 CC-Panes 要求 agent 的对话历史可回滚、可导出、可 `serializeTerminalBuffer`。剥离的实现也很扎实——跨 chunk 截断、组合参数（`\x1b[?1049;25h` → `\x1b[?25h`）、会话切换清残留都覆盖了，且有对应单测。

**问题不在实现，在这个决策的代价从没被量化。**

### 2.2 失效机制（关键前提已在 xterm 源码证实，端到端复现待补）

Claude Code 的 TUI 是 Ink，它的重绘模型是：

1. 记住上一帧占了 N 行
2. 下一帧渲染前发 `\x1b[<N>A`（光标上移 N 行）+ `\x1b[J`（擦到屏幕末尾）
3. 重画

这套**相对定位**在 alt-screen 里是安全的：视口固定、内容不滚动、第 1 行永远在。

剥掉 alt-screen 后跑在主缓冲区里，多了一个 alt-screen 不存在的行为：**滚动**。当光标已在视口底部、新一帧比上一帧高（粘贴长中文让输入框从 2 行涨到 6 行），终端会向上滚动腾行——上一帧的头部被推出视口。此时 Ink 发的 `\x1b[<N>A` 会**在第 1 行被钳住**，锚点永久丢失，之后每一帧都擦错行数、画在旧内容上。

**"钳住"这一步在 xterm 源码里可以直接确认**（`node_modules/@xterm/xterm/src/common/InputHandler.ts:902`）：

```ts
public cursorUp(params: IParams): boolean {
  // stop at scrollTop
  const diffToTop = this._activeBuffer.y - this._activeBuffer.scrollTop;
  if (diffToTop >= 0) {
    this._moveCursor(0, -Math.min(diffToTop, params.params[0] || 1));   // ← 截断
  }
  ...
```

主缓冲区默认 `scrollTop = 0`（视口顶），所以 CUU 会被**静默截断**到视口顶——不报错、不回执，CLI 永远不知道自己的锚点已经错了。alt-screen 里这一步不会发生，因为 TUI 的整帧始终在 `rows` 内、内容不会被滚出去。

这解释了全部观察到的特征：

- **只在"有时候"发生** —— 需要一帧比上一帧高、且恰好在视口底部
- **一旦发生就持续** —— 锚点已丢，后续每帧都错
- **粘贴长中文/图片时最容易触发** —— 这两种恰好让输入框高度突变
- **漏出 `◐m` 这类碎片** —— 被覆盖写坏的转义序列残片
- **点刷新没用** —— 错的内容已经在 buffer 里了

### 2.3 端到端复现（未做，判定方式如下）

1. Settings 把该 CLI 从 `NORMAL_BUFFER_CLI_TOOLS` 摘掉（或临时改代码），重跑同样的粘贴操作，看是否复现
2. 复现时在窗格里按 `Ctrl+L`（Ink 收到会做一次全清+重绘）——能恢复即证实是锚点丢失而非数据损坏
3. 对照组：同一个 Claude Code 跑在 Windows Terminal（不剥 alt-screen）里做同样操作，应不复现

### 2.4 方案（未定，需交叉评审）

| 方案 | 做法 | 代价 |
|------|------|------|
| **a. 收窄适用面** | 只对确认无此问题的 CLI 版本开启剥离，其余走原生 alt-screen | 要维护版本矩阵；Codex 升版静默打断的前例见 docs/45 |
| **b. 做成可配置** | Settings 加开关，默认保持现状，出问题的用户可关 | 把判断推给用户；但成本最低、可立即止血 |
| **c. alt-screen + 退出时回灌** | 不剥离，让 CLI 正常用 alt-screen；在收到 `1049l` 时把 alt buffer 的内容回灌进主缓冲区 | 改动最大，但**同时拿到滚动历史与正确渲染**，是唯一没有取舍的方向 |
| **d. 补偿滚动** | 检测到滚动发生时向 CLI 补一次 SIGWINCH 强制全量重绘 | 治标；重绘闪烁；滚动检测本身不可靠 |

**结论：目标形态是 c，先落 b 止血。**

- **a 直接否掉**：docs/45 已有前车之鉴——Codex v0.145 一次升版就打断了整条 resume 捕获链。把正确性绑在"某个 CLI 的某个版本区间"上，等于给自己排了一颗定时炸弹，且爆炸时症状是静默的显示错乱。
- **d 直接否掉**：治标。滚动检测本身就不可靠（我们看不到 CLI 的内部帧模型），且每次补 SIGWINCH 都是一次可见闪烁——把偶发错乱换成了持续闪烁，用户体感更差。
- **b 先做**：加一个开关（默认维持现状），碰到的用户可以自己关掉换回原生 alt-screen。代价是丢滚动历史，但那是**用户自己在知情下做的取舍**，比现在这种"画面莫名其妙就乱了、还修不好"强。工作量小、可立即发。
- **c 是唯一没有取舍的方向**：不剥离，让 CLI 正常进 alt-screen；在收到 `1049l`（退出备用屏）时把 alt buffer 的内容回灌进主缓冲区。渲染完全正确，滚动历史照样留下。

c 的已知难点，实施前必须回答：

1. 回灌的**时机与粒度**——TUI 每次退出 alt-screen 都回灌一整屏，会不会把中间态刷进历史？可能需要只在会话结束/显式退出时回灌。
2. `serializeTerminalBuffer` / 导出 / `get_session_output` 这些消费方读的是哪个 buffer，全部要跟着改判。
3. daemon 侧的 `ReplayBuffer` 存的是原始字节流，回放时会重新触发 alt-screen 进出——回灌逻辑必须对回放幂等，否则恢复出来的会话历史会翻倍。

> 按项目惯例，c **实施前需单独出 plan 并交叉评审**（改动面大、触及数据完整性）；本节只是方向结论，不是实施规格。

---

## 3. B 类：「刷新终端显示」修的是另一层

### 3.1 现状

`web/components/panes/useTerminalContextMenuActions.ts:84-90` 原实现做三件事：

```ts
rendererControllerRef.current?.clearTextureAtlas("context-menu.refresh");
refitAndRepaintTerminal("context-menu.refresh", { focusIfSafe: true });
repaintTerminal("context-menu.refresh");
```

三件全在渲染层。菜单项注释（`TerminalContextMenu.tsx:40`）写的是"修花屏/变形/未铺满"——那是 WebGL 字形图集错位的场景，与用户点它时的期望（"画面乱了，重画一下"）已经错位。

### 3.2 在 Windows 上它接近字面意义的空操作

`terminalRenderer.ts` 有两条路都把 Windows 打到 DOM 渲染器：

- `:167` `windows-cjk-guard` —— auto 模式下 Windows 恒走 DOM（WebGL 的 CJK 字形图集花屏）
- `:179` `wallpaper-transparency` —— 开壁纸时强制 DOM（WebGL 不透传背景）

DOM 渲染器下：

- `clearTextureAtlas` 首行 `if (!webglAddon) return false`（`terminalRendererController.ts:155`）→ 直接返回
- `repaint` 走 `term.refresh(0, rows-1)`（`:180-193`）→ 重画的是同一份 buffer，像素级一致

即：**Windows 用户点这个菜单项，三件事里两件不执行、一件无可见效果**。

### 3.3 已做的修复（本次）

改为在原有渲染层动作之外，额外向 CLI 请求一次全量重绘——用 **resize 抖动触发 SIGWINCH**（`cols-1` → 恢复 `cols`）：

- TUI（Ink/Codex）收到 SIGWINCH 会重置锚点并全量重画，**能修 2.2 的锚点丢失**
- 普通 shell 只是重画提示符，无副作用
- 比 `Ctrl+L` 好：Ctrl+L 会清屏，属于破坏性操作，不该藏在"刷新显示"后面

约束：

- 共享 PTY 的镜像面板（`StarredMirrorTile` 传 `drivesBackendPty={false}`）与只读面板**不得发 resize**——否则一个镜像会改掉主视图的 PTY 尺寸
- 绕过 `terminalLayoutScheduler` 的 250ms 去抖直接发（否则两次 resize 会被合并成一次，抖动失效）

---

## 4. C 类：卡顿

不在本文展开，链路与三个风险点见 `docs/71-multi-pane-resource-contention.md` §3。与本次现场相关的一条实测：

**本机同时挂着 18 个会话（5 个 active）**（`list_sessions`，2026-08-02）。原先 output 回调完全不看 `isVisibleRef`，后台标签页只是 `display:none` 仍保持挂载 —— 18 份 xterm parser + DOM renderer 全速抢主线程。叠加 Windows 恒 DOM 渲染器与 `allowTransparency: true`（`TerminalView.tsx:851`，无条件常量化），单帧成本本来就偏高。

### 已做的修复（本次）

新增 `terminalHiddenWriteBuffer.ts`：不可见期间**合并而不是丢弃**——把输出攒起来，切回可见时一次性写入。

- 数据零丢失、顺序不变；省掉的是 N 次 parse + N 次渲染帧
- 积压超 512K 字符整块 flush 一次，内存有界；flush 出来的始终是**完整前缀**，不切割转义序列
- 换绑/重连时 `reset()` 丢弃积压，防止上一会话的数据串进新会话

同时把 output 管线整体抽到 `terminalOutputHandler.ts`（TerminalView.tsx 已触行数棘轮上限，抽出后 2249 → 2193，基线同步下调）。

**未做**：docs/71 §3 列的另外两条——daemon 侧 `ws_emitter.rs::publish` 无界广播、写流控只在 Windows 启用——本次没碰。

---

## 5. 新增 Known Gotcha 候选

- **终端"乱了"要先分清是 buffer 乱还是渲染乱，两者同形但治法完全不同**：错乱内容**能选中复制出来** = buffer 级（我们剥了 alt-screen，见本文第 2 节），渲染层刷新永远无效；错乱是色块/字形碎片、复制出来却是正常文本 = 渲染级（WebGL atlas），才是右键「刷新终端显示」的目标。用户报"刷新没用"时，大概率不是刷新坏了，而是他碰到的是前一类。
- **Windows 上终端渲染器恒为 DOM，一切 WebGL 补救路径都是死代码**：`windows-cjk-guard` 与 `wallpaper-transparency` 两条都把 auto 打到 DOM。任何写在 `if (webglAddon)` 里的修复在 Windows 主力场景下**从不执行**，写完自测"没报错"不等于生效。

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

### 2.x 2026-08-09 复审：SIGWINCH 被证伪一半，b 的默认值按 CLI 分裂（已过 WSL Codex 交叉评审，判定「需修改」，修订见 2.x.1）

活体证据（release 实例会话 `db01a58e`，claude spinner 场景）：错乱发生后**拖分隔条触发 SIGWINCH 无效**。定性：错帧已作为历史内容沉入 scrollback，SIGWINCH 只让 CLI 重绘当前视口，救不了已污染的历史；且 spinner 持续运行、锚点持续被钳，新错帧源源不断。结论修订：

- **「检测锚点截断 + 自动 SIGWINCH」的缓解路径被证伪一半**——对增量错帧或有效，对已沉积污染无效。对症动作必须升级为 `xterm.reset()`（清屏+清 scrollback）+ SIGWINCH 连招；右键菜单现有的「刷新终端显示」（渲染层）旁边缺一个「重置终端缓冲区」（buffer 层）。
- **收益按 CLI 重新定价**：codex/opencode 是全屏 TUI，滚动历史回滚看到的是一帧帧 TUI 残影，边际价值低——剥离对它们收益薄、代价照付；claude 是 Ink 内联输出，对话流真的在缓冲区里，历史有实价值。
- **复审后的三步**：
  1. **实证前置（必须先做，不做可能整个方向白干）**：确认 claude 是否真的发 `1049/1047/47`——`detectAlternateBufferTransitions` 现成，加计数日志跑一天。若 claude（Ink 内联）根本不用 alt-screen，则对 claude 剥离是 no-op，本次污染是 Ink 相对定位 + 主缓冲滚动的**原生行为**，方案 c 对 claude 无效，claude 只能走 reset+SIGWINCH 自动化；若确实发，翻回去直接根治。
  2. **b 落地时默认值分裂**：`NORMAL_BUFFER_CLI_TOOLS` 硬编码 Set 改为按 CLI 可配置；codex/opencode 默认翻回原生 alt-screen（收益薄不必等实证），claude 默认维持剥离、等步骤 1 数据。
  3. **c 维持终局定位但不阻塞 1/2**；其三个开放问题不变，另加第四个：休眠 SerializeAddon / checkpoint photo / desync snapshot 重放均假设「内容在主缓冲区」，翻默认前逐一过消费方。daemon `ReplayBuffer` 存 raw 流（剥离只在前端渲染层）、回放再过 `renderTerminalData` 的对称性是现在做对的地方，改动必须保住。

#### 2.x.1 WSL Codex 交叉评审结论（gpt-5.5 xhigh，带行号核实，判定「需修改」）

对上节三步的修订，实施以本节为准：

1. **reset()+SIGWINCH 方向确认，但 reset 要按破坏性操作对待**：`xterm.reset()` 连 buffer/scrollback 一起重置（`@xterm/xterm/src/common/CoreTerminal.ts:244`），是重建前清屏而非轻量补丁——「重置终端缓冲区」按钮的文案与确认交互要按「会清空回滚历史」设计。DECSTBM 不是被漏掉的现成修法（需改渲染契约），不列为备选。
2. **claude 1049 探针必须跨 chunk 状态化**：PTY 会把 `\x1b[?1049h` 切碎分包，逐 chunk 扫 raw 必漏计。计数要挂在 stripper 的 pending 重组之后（复用 `terminalBufferMode.ts:60` 的跨 chunk 机制），不能另起一个无状态扫描。
3. **「翻默认威胁恢复/休眠链路」被评审推翻（上节第四个开放问题降级）**：`SerializeAddon.serialize()` 在 active buffer 为 alternate 时本就附带 `\x1b[?1049h\x1b[H` + alt buffer（`addon-serialize/src/SerializeAddon.ts:511`）；photo 直写 / delta 过渲染双管道（`terminalReplay.ts:71`、`terminalResync.ts:12`）兼容 alt-screen；daemon `replay_snapshot_delta()` 为字符串基线比对 + mismatch 重置（`terminal_daemon_event_bridge.rs:450/583`），幂等风险有限。**仍需逐一过的消费方收窄为**：`serializeTerminalBuffer`、导出、滚轮/滚动交互这几个偏主缓冲语义的点。
4. **步骤 2 拆两拍**：先抽「按 CLI 的缓冲模式 policy + 用户开关」（行为不变的重构），验证后再翻 codex/opencode 默认值。**方案 c 独立成 spec**，不与止血批次绑定。
5. 勘误：§2.1 的代码片段已落后，`NORMAL_BUFFER_CLI_TOOLS` 现为 claude/codex/opencode 三者（`terminalBufferMode.ts:139`）。
5b. **实现落地后的第三轮评审裁决（2026-08-09，同 reviewer）**：整批「需修改→接受两条语义定义后可合并」，语义定义为规格：①`cliBufferModes` 与默认值分裂**只对新会话/新绑定生效**——已绑定会话不热重绑（TerminalView 绑定只在初始化/重连建立），strip↔native 活切换的探针漏计因此只是理论边界；②native 模式下 `serializeTerminalBuffer`/导出读 `buffer.active`，TUI 存活期导出的是**当前活动屏快照**而非滚动历史——判定为诚实语义（全屏 TUI 的"历史"本就是残影，§2.x 原判断）。另确认：wheel 逻辑无需改（本就只在 alternate 转箭头）；后端 `ReplayBuffer::update_buffer_mode()` 的单 chunk 扫描只影响元数据不影响回放幂等；reset 门控（drivesBackendPty && !readOnly）与显隐一致。
6. 附带活体证据：本次评审的 codex 会话自身窗格即出现同型 spinner 交错残帧（`WWoorrkkiinngg`），证实 codex 被剥 alt-screen 后同样中招。
7. **经验观察（弱信号，非判据——本条措辞已过 Codex 二审修订）：A 类错乱常随 spinner 停止「自愈」**。机制是「spinner 停止后最后一帧稳定下来」——没有新帧，错位的相对重绘链就停了；**不是** Ink 的收尾重绘（`unmount()/cleanup()` 仅在应用整体退出时发生）。scrollback 残帧仍在；复发条件是**每次重新满足**「长 spinner + 帧高变化 + 主缓冲滚动」，故「下一轮相似长思考高概率复发」，而非一次触发锁死全会话。注意渲染级花屏也可能恰好因下次稳定 repaint/resize/refresh 而看似消失，**turn/输出边界不能当分类标准**——区分 A 类与渲染级的硬判据仍是两个：错乱内容能否选中复制出正常文本、「刷新终端显示」是否有效。本条的实用价值：用户报障时恰好不闪 ≠ 误报，间歇性是 A 类的常态。

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

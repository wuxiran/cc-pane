# 终端滚动条两个真缺陷（浅色不可见 + 分片正则漏网）

> 状态：**排队中**（等 `web/components/panes/` 的 worker 清完再派）| 基线提交：`6a29b61`

## 背景：现象本身不是 bug

用户报告"Codex 会话看不到滚动条"。调查结论：**这是当前架构的预期行为，不修**。

`terminalBufferMode.ts:26` 的 `NORMAL_BUFFER_CLI_TOOLS = new Set(["claude", "codex"])`
让 CC-Panes 主动剥掉 Codex 的 alt-screen 序列（`TerminalView.tsx:484-488`），
强制它留在 normal buffer。而 Codex 是 Rust TUI（ratatui/crossterm），
用 `\x1b[2J` + 绝对光标定位**就地重画一屏**——被剥掉 alt screen 后，
内容永远只有一屏高，`scrollHeight == clientHeight`，
xterm v6 的 `ScrollbarVisibility.Auto` 判定不可滚动，因此不渲染滑块。

对比 Claude Code（Ink，逐行追加）→ scrollback 持续增长 → 滑块正常出现。

**已决策：保持现状**（推测动机是牺牲滚动条换取 Codex 退出后的历史留存）。
调大 `scrollback` 无效（当前 20000，非零，只是 Codex 不往里写行）。

以下两项是排查过程中发现的**独立真缺陷**，与上述现象无关。

---

## 缺陷 A：浅色主题下终端滚动条滑块不可见

`web/assets/index.css:474`、`:486`、`:499-506` 的滑块配色**只写了
`rgba(255,255,255,...)`，没有 light 模式变体**。

对比同文件全局段 `:446`（light）/ `:454`（dark）是有明暗两套的——终端专段漏了。
结果：浅色主题下白底配白滑块，等于完全看不见。

**改法**：给这几条补 `:not(.dark)` / `.dark` 分支，浅色下用深色半透明滑块
（参考 `:446` 的既有写法保持一致）。

纯样式改动，**零渲染生命周期风险**。

## 缺陷 B：`stripAlternateBufferSequences` 逐 chunk 正则会漏网

`web/components/panes/terminalBufferMode.ts` 的剥离逻辑是对每个 PTY chunk
独立跑正则。两种漏网情况：

1. **跨分片截断**：PTY 把 `\x1b[?1049h` 切成两块（如 `\x1b[?10` + `49h`），
   两块各自都不匹配 → 序列漏网 → Codex **真的进了 alt screen**。
   表现是行为在"无滚动条"和"画面残留"之间**随机抖动**——最难复现的那类 bug。
2. **组合参数形式**：`\x1b[?1049;25h` 这种带多个参数的写法不匹配当前正则。

**改法**：
- 跨 chunk 保留尾部残留缓冲（只需缓存可能构成不完整序列的尾部若干字节）
- 正则支持参数列表形式（`\x1b[?<params>h|l`，params 内含 1049/1047/47 即命中）
- `terminalBufferMode.test.ts` 已存在，补测试：分片截断、组合参数两类用例

改的是纯函数，测试文件已有，**风险可控**。但注意它的输出会写进 xterm，
改动需保证既有断言（`terminalBufferMode.test.ts:21`）继续绿。

---

## 顺带（低优先，判断后决定）

`index.css:462-487` 整段 `.xterm-viewport::-webkit-scrollbar` 是 xterm **v5** 时代写法。
项目用的是 `@xterm/xterm ^6.0.0`（`package.json:61`），v6 已改用 VS Code 的
`ScrollableElement`，真正生效的是 `:489-507` 的 `.xterm-scrollable-element > .scrollbar > .slider`。
那段基本是死代码——不造成问题但误导后来者。可删，或保留并加注释说明是 v5 兼容。

## 明确不做

- **不改** `terminalBufferMode.ts:26` 的 `NORMAL_BUFFER_CLI_TOOLS`（已决策保持现状）
- 不加 `overviewRuler` 选项——它解决不了 Codex 无 scrollback 的问题，
  且会改动 `new Terminal({...})` 配置
- 不自绘滚动条或滚动位置指示器（全仓目前没有，本次不引入）

## 红线

不碰 `TerminalView.tsx` 的渲染生命周期（`init` 闭包、`layoutSchedulerRef.schedule`、
`term.onData`、终端构造/销毁、fit/refit 路径）。本任务理想情况下**完全不需要动
`TerminalView.tsx`**——缺陷 A 在 CSS，缺陷 B 在纯函数。

## 验收

- `npx tsc --noEmit`
- `npm run test:run -- --maxWorkers=3`
- `terminalBufferMode.test.ts` 既有断言继续绿 + 新增分片/组合参数用例
- 手动：切换浅色主题，终端内 hover 时能看见滚动条滑块

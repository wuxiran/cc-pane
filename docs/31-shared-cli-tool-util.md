# 技术债收口：CLI 工具校验与 createPanel 的重复实现

> 状态：待实施 | 基线提交：`6a29b61`（工作树内有 6 个 worker 的未提交改动，**不要动它们**）

## ⚠️ 并发警告

同一工作树内有另一个 worker 正在改
`web/assets/index.css` 和 `web/components/panes/terminalBufferMode.ts`。
**不要碰这两个文件**，也不要碰 `web/components/panes/` 下的其它文件。
**禁止任何 git 写操作**（工作树里有 6 个 worker 的未提交成果，
`add`/`commit`/`stash` 都会波及）。测试若见 `panes/` 相关失败，与本任务无关，忽略并注明。

## 背景

上一轮六个并行 worker 的编排约束（禁止跨目录改动）导致了几处重复实现。
约束本身是对的——它避免了并发写冲突——但债要还。

## 债务 1：CLI 工具白名单校验有两份实现

- `web/components/providers/ProvidersPanel.tsx` 里的 `coerceLaunchTool`
  —— **模块私有，未导出**
- `web/components/launcher/launcherModel.ts` 里的 `coerceDefaultCliTool`
  —— 因 `providers/` 当时禁改而独立实现的同语义版本（代码里已有注释标注这笔债）

两者都在做同一件事：校验一个字符串是否是合法 CLI 工具
（白名单来源 `web/types/provider.ts:223-232` 的 `CLI_TOOL_TABS`），非法值回落。

**改法**：提取到共享位置（建议 `web/utils/cliTool.ts`，或并入既有的相关 util），
两边改为复用。

注意两者语义**可能有细微差异**（例如对 `"none"`、空字符串、`null` 的处理）——
**先读懂两份实现再合并，不要假设它们完全等价**。若确有差异，
在共享函数里用参数或两个具名导出表达，不要强行统一成一个而悄悄改变某一方的行为。
两边现有测试必须继续绿。

## 债务 2：`createPanel` 有两份实现

- `web/stores/usePanesStore.ts:55-68` —— 生产实现
- `web/utils/paneTreeHelpers.ts:9-32` —— 重复实现（`:18` 同样硬编码 `title: "Terminal"`），
  目前**只被测试文件引用**

上一轮修「beside 分屏多出空 Terminal 标签」的 bug 时就是踩在这类默认标签行为上
（见 `docs/25-pane-placement-fix.md`）。两份并存迟早再踩一次。

**改法**：合并为一份。倾向让 `paneTreeHelpers.ts` 复用 store 里的实现，
或把 `createPanel` 提到 `paneTreeHelpers.ts` 由 store 引入——**取决于依赖方向是否会成环**，
先确认再动。

⚠️ `usePanesStore.ts` 里有上一轮 worker 的未提交改动
（`openSessionBesidePane` 的空标签修复 + `resolveAutoDirection` 螺旋方向）。
**合并时不要破坏这些改动**，尤其是 `:1331` 附近
`createPanel(createTab(opts))` 的调用形式——它依赖 `createPanel` 接受可选 tab 参数。

## 明确不做

- 不改 `OrchestratorInput.tsx:41` 的二元塌缩
  （`defaultCliTool === "codex" ? "codex" : "claude"`，把 8 个 CLI 塞进二元判断）——
  它需要 UI 上支持完整 CLI 列表，是功能改动不是重构，**另案**。
- 不改 `useOpenTerminal.ts:35-36`（新建会话不读默认 CLI）——
  需先确认 `FileTreeContextMenu.tsx:198`「在此打开终端」等直调场景是否
  **有意依赖裸 shell 语义**，改错会造成回归。**另案**。
- 不动 17 处裸 `navigator.clipboard` 的 WebKitGTK 隐患（范围大，另案）。

## 验收

- `npx tsc --noEmit`
- `npm run test:run -- --maxWorkers=3`（`panes/` 相关失败不计，见并发警告）
- 合并前后行为等价：`providers/` 与 `launcher/` 两侧既有测试零回归
- `usePanesStore` 相关测试（含上一轮新增的螺旋方向与空标签用例）继续绿

# 补接线：跨 chunk alt-buffer stripper 接进生产路径

> 状态：待实施 | 前置：`docs/29-terminal-scrollbar-defects.md`（缺陷 B 半成品）

## ⚠️ 并发警告

同一工作树内有另一个 worker 正在做技术债收口，范围是
`web/utils/`、`web/components/launcher/`、`web/components/providers/`、
`web/stores/usePanesStore.ts`。**不要碰这些**。
**禁止任何 git 写操作**（工作树里有 7 个 worker 的未提交成果）。
测试若见上述目录相关失败，与本任务无关，忽略并注明。

**本任务只许碰**：

- `web/components/panes/TerminalView.tsx`（**仅** `renderTerminalData` 及其 ref/清理，见下）
- `web/components/panes/terminalBufferMode.ts`（如需微调 stripper API）
- 对应 `*.test.ts(x)`

## 问题

上一轮实现了跨 chunk 安全的 `createAlternateBufferStripper`
（`terminalBufferMode.ts:66`），但**没有接进生产路径**——
`TerminalView.tsx:487` 仍在调用逐 chunk 的旧函数：

```ts
const keepCliOutputInNormalBuffer = shouldKeepCliOutputInNormalBuffer(effectiveCliTool);
const renderTerminalData = useCallback((data: string) => {
  if (!keepCliOutputInNormalBuffer) return data;
  return stripAlternateBufferSequences(data);   // ← 旧的逐 chunk 版本
}, [keepCliOutputInNormalBuffer]);
```

新 stripper 目前**只被测试调用，是死代码**。缺陷 B（PTY 分片把
`\x1b[?1049h` 切成两段导致漏网 → Codex 真的进 alt screen → 行为随机抖动）
**实际未修复**。

这是上一份规格的错误：`docs/29` 写了"理想情况下完全不需要动 TerminalView.tsx"，
但接线必然要改该调用点，因为 stripper 是**有状态**的，需按终端实例持有。

## 改动

把 `renderTerminalData` 改为使用实例级 stripper。

### 关键点

1. **实例持有**：用 `useRef` 持有 stripper，每个 TerminalView 实例一个。
   不要用 `useMemo`（可能被 React 丢弃重算，状态会丢）。
2. **旁路要干净**：`keepCliOutputInNormalBuffer` 为 false 时直接 `return data`——
   此时**不得**把数据喂给 stripper，否则残留缓冲会污染后续。
   若该值在会话中途变化（`effectiveCliTool` 变了），需 reset stripper。
3. **会话切换要 reset**：换 `sessionId` / 重建终端时，上一会话的残留尾部必须丢弃，
   否则会串到新会话的输出里。
4. **销毁要 flush**：会话结束时调 `flush()` 吐出仍被扣留的尾部，
   否则最后几个字节会被吞掉（用户会看到输出末尾缺字符）。
   flush 的结果需要写进终端——确认清理路径上还能写。
   **若此处会触及终端销毁时序（红线），改为在 flush 无法安全写入时放弃该残留，
   并在代码注释里说明这个取舍**——丢几个尾部字节远好于碰渲染生命周期。
5. `MAX_PARTIAL_TAIL_LENGTH = 32` 的上限已在 stripper 内实现（超长直接放行，
   避免无限扣留），接线时不需要额外兜底。

### 红线边界

`renderTerminalData` 是 `useCallback` 包的**纯数据变换**，
**不在** `init` 闭包内，不涉及终端构造/销毁/fit/refit——改它本身不触碰
CLAUDE.md 的"TerminalView 渲染生命周期"红线。

**但**：新增的 ref 清理逻辑若需要挂进 `init` 闭包的 cleanup 数组，
就进入红线区域了。**优先寻找不进 init 闭包的实现方式**
（例如独立的 `useEffect` 依赖 `sessionId` 做 reset）。
若确实绕不开，**停下来在汇报里说明，不要擅自动 init 闭包**。

## 验收

- `npx tsc --noEmit`
- `npx vitest run web/components/panes/ --maxWorkers=2` 全绿
- 补测试：**接线后的** `renderTerminalData` 行为——
  - 分片输入（`\x1b[?10` + `49h` 两次调用）能正确剥离
  - `keepCliOutputInNormalBuffer` 为 false 时数据原样透传且不污染 stripper
  - 会话切换后残留不串台
- 汇报里必须明确：**stripper 现在确实走在生产路径上**
  （给出 `TerminalView.tsx` 里的实际调用行），避免再次出现"实现了但没接线"

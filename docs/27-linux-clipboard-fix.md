# Linux 终端复制粘贴失效修复

> 状态：待实施 | 基线提交：`6a29b61` | 先例提交：`5089593`

## ⚠️ 并发警告

同一工作树内有其它 worker 在改代码。**本任务只许碰下列文件**：

- `web/components/panes/terminalClipboard.ts`
- `web/components/panes/terminalImeGuard.ts`
- `web/components/panes/terminalKeyboard.ts`
- `web/components/panes/TerminalView.tsx`（**仅限**下述几处调用点，见"红线"）
- `src-tauri/src/commands/clipboard_commands.rs`
- `src-tauri/src/commands/screenshot_commands.rs`
- 对应 `*.test.ts(x)`

**不要碰**：`web/components/providers/`、`web/components/resources/`、
`web/stores/usePanesStore.ts`、`web/hooks/useOrchestratorListener.ts`、
`src-tauri/src/services/orchestrator_service.rs`、
`cc-panes-core/src/services/terminal_service.rs`。
**禁止任何 git 写操作**。测试若见上述目录相关失败，与本任务无关，忽略并注明。

## 现象

Linux 下内置终端无法复制粘贴。macOS 曾出过同类问题并已修复。

## 先例：`5089593`

> "fix(terminal): stop clearing native edit state on non-Linux" (6/23)
>
> IME guard 的 `clearNativeEditState`（清空隐藏 textarea + 抹掉 document selection）
> 在每次 paste/copy 时都跑，即使 guard 已禁用。在 Windows WebView2 上破坏了 IME 会话……
> 让 `clearNativeEditState` 在 guard 禁用时成为真正的 no-op；
> 破坏性清理只有 Linux WebKit 的 IME 变通才需要。是 `b2fe6b4` 的回归。

一个文件 6 行：`terminalImeGuard.ts:128-133`。

**注意方向**：那次修复**刻意为 Linux 保留了破坏性清理**——Linux 是唯一还会真正清空
textarea 并抹掉 document selection 的平台。当时只验证了 Linux 的 **IME** 需要它，
**没人验证它对 Linux 的剪贴板有什么影响**。

## 主嫌：复制路径上的 `clearNativeEditState`

`TerminalView.tsx:1377` 在复制成功后立刻调用
`imeGuardRef.current?.clearNativeEditState("copy-selection")`。
在 Linux WebKit（且仅在那里，`5089593` 之后）这会执行
`clearDocumentSelection()` → `textarea.ownerDocument.getSelection()?.removeAllRanges()`
（`terminalImeGuard.ts:72-78`）。

WebKitGTK 上异步剪贴板写入未必在 promise resolve 时就提交到 X11/Wayland selection，
**此时抹掉 document selection 正是丢失 WebKit 剪贴板写入的经典模式**。
同样的调用还在 `:1131` 和 `:1134`（粘贴前后）。

**最高置信度切点**：`TerminalView.tsx:1377` —— 移除或对 Linux 中性化该调用，
完全照搬 `5089593` 为 Windows/macOS 做过的事。同一个函数、同一个参数，只是晚了一个平台。

推荐做法：把 `clearNativeEditState` 拆成"IME 专用"变体（不调用 `clearDocumentSelection`），
或在 reason 为 `"copy-selection"` 时对 Linux 跳过清理。**不要为了修剪贴板而破坏
Linux 的 IME 变通**——那是 `5089593` 明确保留的行为，改动需保证 IME 路径不受影响
（`terminalImeGuard.test.ts:35-46` 是唯一的 Linux WebKit 测试，必须继续绿）。

## 次嫌：粘贴路径的硬失败

`terminalClipboard.ts:103-153` `resolveTerminalPastePayload`，
快捷键/菜单粘贴时 `clipboardData` 恒为 `null`，于是：

1. `readClipboardFilePaths()` 先跑 → Linux 上 `arboard::Clipboard::new()`。
   Wayland 下缺 `zwlr_data_control`（GNOME/Mutter 不实现）时 arboard 返回
   非 `ClipboardNotSupported` 错误，`clipboard_commands.rs:15` 转成 `Err`。
   已被 catch（`terminalClipboard.ts:91-100`），非致命，但白花一次往返。
2. 因 `!clipboardData` 为真，**无条件**跑 `screenshotService.saveClipboardImage()`
   （`terminalClipboard.ts:118-142`）。**若它抛异常，函数直接返回 `{kind:"error"}`，
   永远走不到 `readClipboardText`** —— 文本粘贴被静默转成 "Paste failed" 提示
   （`TerminalView.tsx:1160`）。
   `screenshot_save_clipboard_image`（`screenshot_commands.rs:58-82`）在
   `spawn_blocking` 里调 `clipboard().read_image()`，Linux 上等于在非主线程碰 GTK/arboard，
   panic 会表现为 invoke 拒绝。**这是"Linux 粘贴完全没反应"的合理硬失败路径。**
3. 最后才轮到 `readClipboardText()`（`terminalClipboard.ts:31-74`）。

**改法**：`clipboardData` 为 null 时**先读文本**，图片/文件探测降级为非致命旁路——
任何一步抛异常都不得阻断文本粘贴。

## 附带（判断后决定）

- `terminalKeyboard.ts` 的 `isTerminalPasteShortcut`（`:6-19`）匹配 `v`/`V` 且不排除 shift，
  Ctrl+Shift+V 在 Linux 能匹配，**粘贴快捷键检测不是 bug**。
- 但 **Ctrl+Shift+C 完全没被处理**：`TerminalView.tsx:1368-1389` 的复制分支要求
  `!e.shiftKey`，Ctrl+Shift+C 落到 `useShortcutsStore.ts:165` 的 `shouldTerminalHandleKey`。
  Linux 终端习惯用 Ctrl+Shift+C 复制，建议补上。
- `clipboard_commands.rs:15` 可把更多 arboard 错误变体当作"空剪贴板"而非 `Err`。

## 不做（本次范围外）

全应用只有终端走 Tauri 剪贴板插件，其它 **17 处**（FileTreeContextMenu、ProjectListView、
WorktreeManager、SshMachinesView、ResumeDetailPopover、TaskDetailPanel、
WebAccessSection、SharedMcpSection…）都是裸 `navigator.clipboard.writeText`，
在 WebKitGTK 上会静默失败。这是更大范围的隐患，**另案处理**，本次不动。
在汇报里确认这个判断即可。

Tauri 权限已排除：`capabilities/default.json:18-20` 三平台一致，不是权限问题。

## 红线

**不要碰**（CLAUDE.md 渲染生命周期）：`TerminalView.tsx:1393-1400` 起的 `init` 闭包内容——
`layoutSchedulerRef.schedule("initial.fit")`、`term.onData`、终端构造/销毁、
fit/refit 路径、`handleMenuRefreshTerminal`。

**可以碰**（属事件接线而非生命周期）：`copyTerminalSelection` 函数体
（`TerminalView.tsx:288-302`）、`clearNativeEditState` 的调用点
（`:1131`、`:1134`、`:1377`）。若需在 `:1214-1310` 的 `if (textarea)` 块内加监听，
必须严格遵守 `:1311-1315` 的清理数组（`cleanupNativeMenuBlockers`、`nativeMenuCleanupRef`）。

## 验收

- `npx tsc --noEmit`
- `npm run test:run -- --maxWorkers=3`（高负载下 vitest 偶发 fork 超时假失败，重跑再判）
- `terminalImeGuard.test.ts` 的 Linux WebKit 用例必须继续绿
- `cargo check --workspace` + `cargo clippy --workspace -- -D warnings`（若动了 Rust）
- 为 `resolveTerminalPastePayload` 补测试：图片探测抛异常时仍能回退到文本粘贴
- **无法在本机验证 Linux 真机行为**——请在汇报里明确标注哪些结论是推理、
  哪些有测试覆盖，便于用户在 Linux 上实测确认

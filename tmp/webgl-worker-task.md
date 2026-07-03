# Worker 任务：验证并收尾 WebGL 终端字体清晰度修复

你是 CC-Panes 的 worker，由 leader 派发，**项目本地（local runtime）Claude 实例**。在 `main` 分支工作。

## 背景
刚提交了 commit `a61b75e` —— `fix(terminal): keep WebGL glyphs crisp on first paint and font change`，只改了 `web/components/panes/TerminalView.tsx`：
1. **首屏**：`init` 里在构造 `Terminal` **之前** `await waitForTerminalFont(fontSize, fontFamily)`（`document.fonts.load(配置字体)` + `document.fonts.ready`，1.5s 超时兜底）；await 后重读 terminal settings 再构造，避免泄漏与用旧字体建终端。
2. **换字体**：appearance effect 里用 `lastAppearanceFontRef` 比对 `fontSize|fontFamily`，仅字体真正变化时等 `document.fonts.ready` 后 `clearTextureAtlas("settings.font-change")` + 强制 refit；baseline 在 `init` 创建终端时 seed；cursor 改动不触发。

已过：`tsc --noEmit`、`terminalRenderer*` 12 tests。已自审 + Codex 独立审对账（3 必修全解、2 建议采纳）。

## 你的任务（按序）
1. **拉取确认**：`git -C D:\04_workspace_rust\cc-book log --oneline -3`，确认 `a61b75e` 在 HEAD；`git show --stat a61b75e`。
2. **跑校验**：`npx tsc --noEmit`；`npm run test:run -- terminalRenderer`（应 12 passed）。如本机缺 rollup/vitest 原生包导致 vitest 起不来，按现有 package-lock `npm install --include=optional` 后重试，并在报告里注明环境处理。
3. **实测（关键）**：在当前运行的 CC-Panes dev/release 里：
   - 新开终端，看**首屏**字体是否清晰（不再需要手动刷一下才不糊）。
   - 进 Settings → 终端，**改字体/字号**，回终端看是否**立即清晰**、无残留旧字形（糊）。
   - 切换 WebGL/DOM 渲染器模式（若 Settings 有该项），各测一遍；DOM 模式不应有副作用。
   - 多次连续改字号、切布局回来，确认无花屏/空白/卡。
4. **若仍复现 字糊/刷新问题**：在 `TerminalView.tsx` / `terminalRendererController.ts` 范围内定位并**最小化修复**（不要大重构），补/改测试，再次跑校验。
5. **不要**改其它无关文件（`cc-cli-adapters/src/opencode.rs`、`src-tauri/.../orchestrator_service.rs` 等当前工作区既有改动**保持不动**）。**不要** push；改动留在本地 commit（如有新修复，单独 commit，message 用 `fix(terminal): ...`）。

## 完成后
用 worker 上报机制 `report_to_leader` 回报 leader（leaderId 见启动时注入），summary 给出：校验结果（tsc/tests）、实测结论（首屏/换字体是否还糊）、是否有新增修复（commit hash + 改动点）、遗留项。并在终端打印一行 `WORKER_DONE:` 开头的简短结论作兜底。

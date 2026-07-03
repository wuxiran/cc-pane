# Code review request: xterm WebGL font-crispness tuning

你是 CC-Panes 项目的**只读代码评审者**（adversarial reviewer）。请对下面这次未提交的改动做同行评审。

## 硬约束
- **不要修改任何文件**，不要 `git add`/`commit`/`push`。
- 只读分析；如需看上下文，自己 `cat`/`grep` 仓库文件。
- 评审完成后用一段结构化结论回复（必修/建议/通过项），并调用 worker 上报机制把结论 report 给 leader。

## 背景 / 意图
用户反馈终端在 **换字体/字号** 或 **首屏** 时出现 **字糊 / 乱码**（WebGL 渲染器）。社区对 xterm WebGL 的标准调教是：**字体就绪后再建/重建纹理图集**，而不是高频 `refresh()`。本次改动只动 `web/components/panes/TerminalView.tsx`，加了两处：

1. **首屏**：`term.open()` 之前 `await document.fonts.ready`，确保配置字体已加载再让 WebGL 建首个 glyph atlas；await 后重新校验 `isMounted && terminalRef.current`。
2. **换字体**：appearance effect 里用 `lastAppearanceFontRef` 比对 `fontSize|fontFamily`，**仅字体真正变化**时，等 `document.fonts.ready` 后 `clearTextureAtlas("settings.font-change")` + 强制 refit。光标样式/闪烁变化不触发图集清理。

现有代码已有 Windows 下 DPR/休眠/context-loss 的 WebGL 恢复（`scheduleWebglRecovery`/`recreateWebgl`/heartbeat），本次只补"字体维度"。

## 请重点审查
1. **正确性**：`await document.fonts.ready` 放在 `term.open` 前是否会引入竞态？init 是 async，await 期间组件可能卸载/重连——`isMounted`/`terminalRef.current` 复检是否足够？有没有别的 ref（如 `terminalInstanceRef`）需要复检？
2. **图集清理时机**：`clearTextureAtlas` 仅在 `rendererControllerRef.current` 存在且为 webgl 时有效（DOM 下 no-op）。font-change 的 `ready.then` 回调里只校验了 `terminalInstanceRef.current !== term`，是否够？renderer 在 await 期间被 dispose/切 DOM 会怎样？
3. **重复/抖动**：appearance effect 依赖 4 个值，cursor 改动会重跑 effect 但 `fontChanged` 应为 false，确认不会误清图集。`document.fonts.ready` 已 resolve 时 `.then` 仍异步，会不会和 `schedule("settings.terminal-appearance")` 的 force refit 顺序冲突/二次抖动？
4. **跨平台/边界**：jsdom/测试环境 `document.fonts` 可能不存在——optional chaining 是否覆盖？非 Windows / DOM 渲染器下是否完全无副作用？
5. **是否遗漏**：用户原始诉求里"首屏糊"和"换字体糊"是否都被覆盖？DPR 变化导致的糊是否已被现有 Windows 恢复路径覆盖（不在本次范围但请确认没有回归）。

## 改动 diff

```diff
diff --git a/web/components/panes/TerminalView.tsx b/web/components/panes/TerminalView.tsx
@@ -901,6 +901,18 @@
         const fit = new FitAddon();
         term.loadAddon(fit);
 
+        // Ensure the configured terminal font is loaded before the renderer
+        // builds its first glyph atlas. Otherwise WebGL rasterizes a fallback
+        // font and the first paint looks blurry/garbled until a manual refresh.
+        if (typeof document !== "undefined" && document.fonts?.ready) {
+          try {
+            await document.fonts.ready;
+          } catch {
+            // Font readiness is best-effort; never block terminal creation.
+          }
+          if (!isMounted || !terminalRef.current) return;
+        }
+
         term.open(terminalRef.current);
@@ -1663,14 +1675,36 @@
       layoutSchedulerRef.current?.schedule("theme.change");
     }, [terminalTheme]);
 
+    const lastAppearanceFontRef = useRef<string | null>(null);
     useEffect(() => {
       const term = terminalInstanceRef.current;
       if (!term) return;
 
+      const fontSignature = `${terminalFontSize}|${terminalFontFamily}`;
+      const fontChanged =
+        lastAppearanceFontRef.current !== null &&
+        lastAppearanceFontRef.current !== fontSignature;
+      lastAppearanceFontRef.current = fontSignature;
+
       term.options.fontSize = terminalFontSize;
       term.options.fontFamily = terminalFontFamily;
       term.options.cursorStyle = terminalCursorStyle;
       term.options.cursorBlink = terminalCursorBlink;
+
+      if (fontChanged) {
+        const ready =
+          typeof document !== "undefined" && document.fonts?.ready
+            ? document.fonts.ready
+            : Promise.resolve();
+        void ready.then(() => {
+          if (terminalInstanceRef.current !== term) return;
+          rendererControllerRef.current?.clearTextureAtlas("settings.font-change");
+          layoutSchedulerRef.current?.schedule("settings.font-change", { force: true });
+        });
+      }
       layoutSchedulerRef.current?.schedule("settings.terminal-appearance", { force: true });
     }, [
       terminalCursorBlink,
       terminalCursorStyle,
       terminalFontFamily,
       terminalFontSize,
     ]);
```

请给出：**必修问题（如有）/ 建议优化 / 通过确认**，并附具体行号与改法建议。

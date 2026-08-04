import { useEffect } from "react";
import type { Terminal } from "@xterm/xterm";

import { applyTerminalElementTheme, waitForTerminalFont } from "./terminalViewHelpers";
import type { TerminalThemePalette } from "./terminalTheme";
import type { TerminalLayoutScheduler } from "./terminalLayoutScheduler";
import type { TerminalRendererController } from "./terminalRendererController";

interface RefValue<T> {
  current: T;
}

interface UseTerminalAppearanceSyncOptions {
  terminalInstanceRef: RefValue<Terminal | null>;
  layoutSchedulerRef: RefValue<TerminalLayoutScheduler | null>;
  rendererControllerRef: RefValue<TerminalRendererController | null>;
  /** 构造时播种的字体签名基线（`${fontSize}|${fontFamily}`）。 */
  lastAppearanceFontRef: RefValue<string | null>;
  xtermTheme: TerminalThemePalette;
  fontSize: number;
  fontFamily: string;
  cursorStyle: "block" | "underline" | "bar";
  cursorBlink: boolean;
  scrollback: number;
}

/** 设置/主题变更 → 活实例热更（从 TerminalView 抽出，行数棘轮）。 */
export function useTerminalAppearanceSync({
  terminalInstanceRef,
  layoutSchedulerRef,
  rendererControllerRef,
  lastAppearanceFontRef,
  xtermTheme,
  fontSize,
  fontFamily,
  cursorStyle,
  cursorBlink,
  scrollback,
}: UseTerminalAppearanceSyncOptions): void {
  useEffect(() => {
    const term = terminalInstanceRef.current;
    if (!term) return;

    term.options.theme = xtermTheme;
    applyTerminalElementTheme(term, xtermTheme);
    layoutSchedulerRef.current?.schedule("theme.change");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xtermTheme]);

  useEffect(() => {
    const term = terminalInstanceRef.current;
    if (!term) return;

    const fontSignature = `${fontSize}|${fontFamily}`;
    const fontChanged =
      lastAppearanceFontRef.current !== null &&
      lastAppearanceFontRef.current !== fontSignature;
    lastAppearanceFontRef.current = fontSignature;

    term.options.fontSize = fontSize;
    term.options.fontFamily = fontFamily;
    term.options.cursorStyle = cursorStyle;
    term.options.cursorBlink = cursorBlink;
    // xterm 6 起 scrollback 运行时可热更：改小立即裁掉最旧的超出行（不可恢复），
    // 改大对已裁行无追溯，仅对后续输出生效。
    term.options.scrollback = scrollback;

    if (fontChanged) {
      // WebGL caches glyphs in a texture atlas keyed by the previous font; if
      // it is not cleared the new font renders from stale (blurry/garbled)
      // glyphs. `document.fonts.ready` alone is not enough here: canvas
      // measurement does not trigger @font-face lazy-loading, so a
      // not-yet-requested family leaves `ready` already resolved and the
      // atlas rebuilds from the fallback font. Explicitly request the
      // family first (same path as terminal creation).
      void waitForTerminalFont(fontSize, fontFamily)
        .then(() => {
          if (terminalInstanceRef.current !== term) return;
          rendererControllerRef.current?.clearTextureAtlas("settings.font-change");
          layoutSchedulerRef.current?.schedule("settings.font-change", { force: true });
        })
        .catch(() => {
          // Font readiness is best-effort; the immediate refit below still runs.
        });
    }
    layoutSchedulerRef.current?.schedule("settings.terminal-appearance", { force: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursorBlink, cursorStyle, fontFamily, fontSize, scrollback]);
}

// TerminalView 的模块级纯辅助：字体预热、光标样式归一、启动参数推导、
// 系统回写与提示。从 TerminalView.tsx 拆出（该文件已触到行数棘轮上限，
// 见 web/test/lineRatchet.test.ts），与同目录既有的 terminalXxx.ts 一脉。
//
// 判据：只依赖入参与全局单例、不碰组件内 ref/state 的才放这里。
import { invoke } from "@tauri-apps/api/core";
import type { Terminal } from "@xterm/xterm";

import { terminalService } from "@/services";
import { isTauriRuntime } from "@/services/runtime";
import { useTerminalStatusStore } from "@/stores";
import type { TerminalThemePalette } from "./terminalTheme";

export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/** [`resolveNativeMenuBlock`] 的裁决。`blocked` 为假时两个字段都无意义。 */
export interface NativeMenuBlockDecision {
  /** 是否要 preventDefault 掉原生菜单。 */
  blocked: boolean;
  /** 是否连传播一起掐断（stopPropagation + stopImmediatePropagation）。 */
  stopPropagation: boolean;
}

/**
 * macOS 终端区的原生菜单拦截决策。
 *
 * 背景：mac 的 WKWebView 会给 xterm 的 textarea 弹原生编辑菜单（查找/服务/拼写检查），
 * 必须 `preventDefault` 压掉。**但 contextmenu 必须继续传播**——TerminalContextMenu
 * （Radix）挂在外层，靠冒泡阶段的 `onContextMenu` 打开自定义菜单，且它自己也会
 * preventDefault，压制原生菜单这件事不会因为放行而失效。
 *
 * 早期实现连 contextmenu 一起 `stopImmediatePropagation`，事件在捕获阶段就死了，
 * 于是 macOS 上右键**既没有原生菜单也没有自定义菜单**——表现为「面板无法右键」。
 *
 * 非 mac 平台一律不拦截：那些 WebView 不弹这个原生菜单，Radix 自己处理就够。
 */
export function resolveNativeMenuBlock(input: {
  eventType: string;
  button?: number;
  ctrlKey?: boolean;
  isMac: boolean;
}): NativeMenuBlockDecision {
  const PASS = { blocked: false, stopPropagation: false };
  const { eventType, button, ctrlKey = false, isMac } = input;
  if (!isMac) return PASS;

  // contextmenu / auxclick 本身就是菜单事件，不必看 button（右键 vs ctrl+左键都会来）。
  const isMenuEvent = eventType === "contextmenu" || eventType === "auxclick";
  // mac 惯例：ctrl + 左键 等同右键。
  const isRightButton = button === 2;
  const isCtrlLeftClick = ctrlKey && button === 0;
  if (!isMenuEvent && !isRightButton && !isCtrlLeftClick) return PASS;

  return { blocked: true, stopPropagation: eventType !== "contextmenu" };
}

const TERMINAL_FONT_WAIT_TIMEOUT_MS = 1_500;

// Best-effort wait for the configured terminal font to be ready before the
// WebGL renderer rasterizes its first glyph atlas (otherwise the first paint
// uses a blurry fallback). `document.fonts.ready` alone only settles fonts the
// page already requested, so we also explicitly request the configured family.
// A timeout guarantees a never-resolving font load can't block the terminal.
export async function waitForTerminalFont(
  fontSize: number,
  fontFamily: string,
): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;

  const loadFont = (async () => {
    try {
      await document.fonts.load(`${fontSize}px ${fontFamily}`);
    } catch {
      // Ignore parse/load failures; fall through to the readiness signal.
    }
    try {
      await document.fonts.ready;
    } catch {
      // Best-effort only.
    }
  })();

  const timeout = new Promise<void>((resolve) => {
    setTimeout(resolve, TERMINAL_FONT_WAIT_TIMEOUT_MS);
  });

  await Promise.race([loadFont, timeout]);
}

export type TerminalCursorStyle = "block" | "underline" | "bar";

export function setMacosTerminalNativeFocus(focused: boolean): void {
  if (!IS_MAC || !isTauriRuntime()) return;
  void invoke("set_macos_terminal_focused", { focused }).catch(() => {});
}

export function normalizeTerminalCursorStyle(value?: string | null): TerminalCursorStyle {
  return value === "underline" || value === "bar" ? value : "block";
}

export function findLiveSavedSessionId(savedSessionId?: string): string | null {
  if (!savedSessionId) return null;
  // 读共享状态缓存（useTerminalStatusStore，由 terminal-status 事件 + 定时刷新维护），
  // 不再每个 tab 各发一次 getAllStatus IPC。重启时几十个 tab 同时挂载会并发打几十次
  // get_all_terminal_status，把后端拖住，让后续 tab 卡在进启动队列前的这个 await，
  // 导致"放约 10 个就停"的恢复 stall。同步读内存 map 不会 hang，也消除了 IPC 扇出。
  // 缓存里没有（冷启动未命中）→ 视为非 live → 走 relaunch（队列），功能不丢。
  const info = useTerminalStatusStore.getState().statusMap.get(savedSessionId);
  return info && info.status !== "exited" ? savedSessionId : null;
}

export function writeTerminalReply(
  sessionId: string | null,
  response: string,
  onError: (error: unknown) => void,
) {
  if (!sessionId) return;
  void terminalService.write(sessionId, response, { source: "system" }).catch(onError);
}

export function applyTerminalElementTheme(
  term: Terminal | null,
  theme: TerminalThemePalette,
) {
  if (!term?.element) return;
  term.element.style.backgroundColor = theme.background;
  term.element.style.color = theme.foreground;
}

export function repaintTerminalWhenVisible(
  isRenderVisible: () => boolean,
  repaint: (reason: string) => void,
  reason: string,
): boolean {
  if (!isRenderVisible()) return false;
  repaint(reason);
  return true;
}

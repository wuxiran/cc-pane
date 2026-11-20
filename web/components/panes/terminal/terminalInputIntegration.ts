// 终端输入装配（F2 拖放/粘贴 + 文本域集成 + 自定义键）从 useTerminalInstanceInit
// 抽离，保持初始化 hook 在行数红线内。逻辑与原内联块逐行等价：
// 拖放、粘贴、原生菜单/文本域、IME 守卫与快捷键拦截集中在此装配。
import type { Terminal } from "@xterm/xterm";
import type { TFunction } from "i18next";
import { toast } from "@/components/ui/toast";
import { createTerminalPasteHandlers } from "./terminalPaste";
import { attachTerminalTextareaIntegration } from "./terminalTextareaIntegration";
import { attachTerminalDragDropListener } from "./terminalDragDrop";
import { createTerminalCustomKeyHandler } from "./terminalCustomKeyHandler";
import type { TerminalRuntimeKind } from "../terminalDropPaths";
import type { attachTerminalInputTrace } from "../terminalInputTrace";
import type { attachTerminalDomInputFallback } from "../terminalDomInputFallback";
import type { attachTerminalImeGuard } from "../terminalImeGuard";

interface RefValue<T> {
  current: T;
}

export interface TerminalInputIntegrationParams {
  /** 仅按真值判定运行时类型（ssh/wsl）；与 TerminalViewProps 结构兼容。 */
  props: { ssh?: unknown; wsl?: unknown };
  t: TFunction<"panes">;
  term: Terminal;
  debugLog: (event: string, payload?: Record<string, unknown>) => void;
  getHost: () => HTMLDivElement | null;
  isMounted: () => boolean;
  pasteHandlerRef: RefValue<((e: ClipboardEvent) => void) | null>;
  pasteRequestRef: RefValue<(() => void) | null>;
  nativeMenuCleanupRef: RefValue<(() => void) | null>;
  inputDebugCleanupRef: RefValue<(() => void) | null>;
  inputTraceSeqRef: RefValue<number>;
  lastShortcutPasteAtRef: RefValue<number>;
  dragDropUnlistenRef: RefValue<(() => void) | null>;
  inputTraceRef: RefValue<ReturnType<typeof attachTerminalInputTrace> | null>;
  domInputFallbackRef: RefValue<ReturnType<typeof attachTerminalDomInputFallback> | null>;
  imeGuardRef: RefValue<ReturnType<typeof attachTerminalImeGuard> | null>;
  currentSessionIdRef: RefValue<string | null>;
  readOnlyRef: RefValue<boolean>;
  isDisconnectedRef: RefValue<boolean>;
}

/**
 * 装配终端的输入相关集成：粘贴处理、文本域/原生菜单、拖放监听、自定义键处理。
 * 这些共享同一个 runtimeKind 与「SSH 收到宿主本地路径」的诚实提示回调。
 */
export function attachTerminalInputIntegration({
  props,
  t,
  term,
  debugLog,
  getHost,
  isMounted,
  pasteHandlerRef,
  pasteRequestRef,
  nativeMenuCleanupRef,
  inputDebugCleanupRef,
  inputTraceSeqRef,
  lastShortcutPasteAtRef,
  dragDropUnlistenRef,
  inputTraceRef,
  domInputFallbackRef,
  imeGuardRef,
  currentSessionIdRef,
  readOnlyRef,
  isDisconnectedRef,
}: TerminalInputIntegrationParams): void {
  const dropRuntimeKind: TerminalRuntimeKind = props.ssh ? "ssh" : props.wsl ? "wsl" : "local";
  // SSH 会话拿到宿主本地路径（拖放或粘贴文件）时，不插入无效路径，
  // 给出诚实提示。拖放与粘贴共用同一文案与回调。
  const notifyUnsupportedLocalPaths = (pathCount: number) => {
    toast.info(t("sshLocalDropUnsupported"), {
      description: t("sshLocalDropUnsupportedHint", { pathCount }),
    });
  };

  const { pasteTextIntoTerminal, pasteTerminalPayload } = createTerminalPasteHandlers({
    term,
    debugLog,
    lastShortcutPasteAtRef,
    getRuntimeKind: () => dropRuntimeKind,
    onUnsupportedPaths: notifyUnsupportedLocalPaths,
  });

  pasteRequestRef.current = () => pasteTerminalPayload(null);

  // 装配点处于初始化同步段，host 必非空；getHost 取值后防御性判空，行为不变。
  const host = getHost();
  if (host) {
    nativeMenuCleanupRef.current = attachTerminalTextareaIntegration({
      term,
      host,
      debugLog,
      pasteTerminalPayload,
      currentSessionIdRef,
      readOnlyRef,
      isDisconnectedRef,
      inputTraceSeqRef,
      pasteHandlerRef,
      inputDebugCleanupRef,
      inputTraceRef,
      domInputFallbackRef,
      imeGuardRef,
    });
  }

  attachTerminalDragDropListener({
    getHost,
    isMounted,
    debugLog,
    pasteText: pasteTextIntoTerminal,
    getRuntimeKind: () => dropRuntimeKind,
    onUnsupportedDrop: notifyUnsupportedLocalPaths,
    setUnlisten: (unlisten) => {
      dragDropUnlistenRef.current = unlisten;
    },
  });

  term.attachCustomKeyEventHandler(
    createTerminalCustomKeyHandler({
      term,
      getImeGuard: () => imeGuardRef.current,
      debugLog,
      pasteTerminalPayload,
    })
  );
}

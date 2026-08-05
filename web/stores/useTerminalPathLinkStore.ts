import { create } from "zustand";
import { terminalPathLinkService, type ResolvedTerminalPathLink } from "@/services/terminalPathLinkService";
import type { TerminalPathReference } from "@/lib/terminalPathLink";

export type TerminalPathLinkAction = "openEditor" | "openDefault" | "reveal" | "copy";

interface OpenDialogState {
  requestId: number;
  sessionId: string;
  rawPath: string;
  line?: number;
  column?: number;
}

export type TerminalPathLinkDialogState =
  | { phase: "closed" }
  | (OpenDialogState & { phase: "resolving" })
  | (OpenDialogState & ResolvedTerminalPathLink & {
      phase: "ready" | "acting";
      pendingAction?: TerminalPathLinkAction;
    });

interface TerminalPathLinkStore {
  dialog: TerminalPathLinkDialogState;
  requestSequence: number;
  open(reference: TerminalPathReference, sessionId: string): Promise<void>;
  close(): void;
  runAction(
    action: TerminalPathLinkAction,
    runner: () => Promise<void>,
    closeOnSuccess?: boolean,
  ): Promise<boolean>;
  resetForTest(): void;
}

const RESOLVE_TIMEOUT_MS = 10_000;
const ACTION_TIMEOUT_MS = 15_000;

function timeoutError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(timeoutError(code, "The terminal path request timed out")),
      timeoutMs,
    );
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function matchesRequest(dialog: TerminalPathLinkDialogState, requestId: number): boolean {
  return dialog.phase !== "closed" && dialog.requestId === requestId;
}

export const useTerminalPathLinkStore = create<TerminalPathLinkStore>((set, get) => ({
  dialog: { phase: "closed" },
  requestSequence: 0,

  async open(reference, sessionId) {
    const requestId = get().requestSequence + 1;
    set({
      requestSequence: requestId,
      dialog: {
        phase: "resolving",
        requestId,
        sessionId,
        rawPath: reference.path,
        line: reference.line,
        column: reference.column,
      },
    });

    try {
      const resolved = await withTimeout(
        terminalPathLinkService.resolve({ sessionId, rawPath: reference.path }),
        RESOLVE_TIMEOUT_MS,
        "TERMINAL_PATH_RESOLVE_TIMEOUT",
      );
      const current = get().dialog;
      if (current.phase === "closed" || current.requestId !== requestId) return;
      set({ dialog: { ...current, ...resolved, phase: "ready" } });
    } catch (error) {
      if (!matchesRequest(get().dialog, requestId)) return;
      set({ dialog: { phase: "closed" } });
      throw error;
    }
  },

  close() {
    set((state) => ({
      requestSequence: state.requestSequence + 1,
      dialog: { phase: "closed" },
    }));
  },

  async runAction(action, runner, closeOnSuccess = true) {
    const current = get().dialog;
    if (current.phase !== "ready") return false;
    const requestId = current.requestId;
    set({ dialog: { ...current, phase: "acting", pendingAction: action } });

    try {
      await withTimeout(runner(), ACTION_TIMEOUT_MS, "TERMINAL_PATH_ACTION_TIMEOUT");
      if (!matchesRequest(get().dialog, requestId)) return true;
      set({
        dialog: closeOnSuccess
          ? { phase: "closed" }
          : { ...current, phase: "ready", pendingAction: undefined },
      });
      return true;
    } catch (error) {
      if (matchesRequest(get().dialog, requestId)) {
        set({ dialog: { ...current, phase: "ready", pendingAction: undefined } });
      }
      throw error;
    }
  },

  resetForTest() {
    set({ dialog: { phase: "closed" }, requestSequence: 0 });
  },
}));

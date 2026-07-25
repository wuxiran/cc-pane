import { useCallback } from "react";
import { create } from "zustand";
import {
  useDialogStore,
  useFullscreenStore,
  useMiniModeStore,
  useTerminalStatusStore,
} from "@/stores";
import { isBusyStatus, type TerminalStatusType } from "@/types";

export type InterruptKind = "update" | "tip";

export interface InterruptGateDeps {
  now: () => number;
  appStartedAt: number;
  sessionStatuses: TerminalStatusType[];
  hasOpenDialog: boolean;
  isMiniMode: boolean;
  isFullscreen: boolean;
  activeInterrupt: InterruptKind | null;
}

export type GateBlockReason =
  | "agentBusy"
  | "startupGrace"
  | "dialogOpen"
  | "miniMode"
  | "fullscreen"
  | "occupied";

const STARTUP_GRACE_MS = 30_000;
const INTERRUPT_PRIORITY: Record<InterruptKind, number> = {
  tip: 0,
  update: 1,
};
const appStartedAt = Date.now();

export function checkInterruptGate(
  kind: InterruptKind,
  deps: InterruptGateDeps,
): GateBlockReason | null {
  if (deps.sessionStatuses.some((status) => isBusyStatus(status) || status === "waitingInput")) {
    return "agentBusy";
  }
  if (deps.now() - deps.appStartedAt < STARTUP_GRACE_MS) return "startupGrace";
  if (deps.hasOpenDialog) return "dialogOpen";
  if (deps.isMiniMode) return "miniMode";
  if (deps.isFullscreen) return "fullscreen";
  if (
    deps.activeInterrupt !== null &&
    INTERRUPT_PRIORITY[deps.activeInterrupt] >= INTERRUPT_PRIORITY[kind]
  ) {
    return "occupied";
  }
  return null;
}

interface InterruptCoordinatorState {
  activeInterrupt: InterruptKind | null;
  occupy: (kind: InterruptKind) => void;
  release: (kind: InterruptKind) => void;
}

export const useInterruptCoordinatorStore = create<InterruptCoordinatorState>((set) => ({
  activeInterrupt: null,
  occupy: (kind) => set({ activeInterrupt: kind }),
  release: (kind) =>
    set((state) => (state.activeInterrupt === kind ? { activeInterrupt: null } : state)),
}));

function hasOpenDialog(): boolean {
  const dialogs = useDialogStore.getState();
  return (
    dialogs.settingsOpen ||
    dialogs.journalOpen ||
    dialogs.localHistoryOpen ||
    dialogs.gitTimelineOpen ||
    dialogs.sessionCleanerOpen ||
    dialogs.todoOpen ||
    dialogs.plansOpen ||
    dialogs.selfChatOpen ||
    dialogs.aiPanelOpen ||
    dialogs.onboardingOpen ||
    dialogs.workspaceEnvironmentOpen ||
    dialogs.launcherOpen
  );
}

export interface InterruptGateController {
  activeInterrupt: InterruptKind | null;
  check: (options?: { ignoreOwnInterrupt?: boolean }) => GateBlockReason | null;
  occupy: () => void;
  release: () => void;
}

/** 从真实 store 读取最新状态；调用方可在定时器和点击瞬间重复检查。 */
export function useInterruptGate(kind: InterruptKind): InterruptGateController {
  const activeInterrupt = useInterruptCoordinatorStore((state) => state.activeInterrupt);

  const check = useCallback(
    (options?: { ignoreOwnInterrupt?: boolean }) => {
      const currentInterrupt = useInterruptCoordinatorStore.getState().activeInterrupt;
      return checkInterruptGate(kind, {
        now: Date.now,
        appStartedAt,
        sessionStatuses: Array.from(
          useTerminalStatusStore.getState().statusMap.values(),
          (info) => info.status,
        ),
        hasOpenDialog: hasOpenDialog(),
        isMiniMode: useMiniModeStore.getState().isMiniMode,
        isFullscreen: useFullscreenStore.getState().isFullscreen,
        activeInterrupt:
          options?.ignoreOwnInterrupt && currentInterrupt === kind ? null : currentInterrupt,
      });
    },
    [kind],
  );

  const occupy = useCallback(() => {
    useInterruptCoordinatorStore.getState().occupy(kind);
  }, [kind]);
  const release = useCallback(() => {
    useInterruptCoordinatorStore.getState().release(kind);
  }, [kind]);

  return { activeInterrupt, check, occupy, release };
}

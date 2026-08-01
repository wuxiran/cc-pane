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

/**
 * 哪些打扰会被「有会话忙碌」挡住。
 *
 * `tip: true` —— 功能提示在 agent 忙的时候弹正是 docs/58 说的那种烦人，
 * 「tip 系统失败只有一种方式：烦人」。
 *
 * `update: false` —— CC-Panes 的典型用法就是长时间挂着 agent 干活，几乎总有 busy
 * 会话；若一并挡住，更新卡片不是不显示，而是**永远在等**。放行的只是「显示卡片」
 * ——它在右下角不打断任何操作；真正会杀掉在跑的活的是**安装**，那条路径另有
 * `hasBusySessions()` 的确认警告（见 UpdateNotification 的 busyAtConfirmation），
 * 不受本放行影响。
 *
 * 规则按 kind 写在这里、不做成调用方传的布尔参数：否则规则散到调用方去，
 * 下一个人不读闸门源码就不知道有这回事。
 */
const AGENT_BUSY_BLOCKS: Record<InterruptKind, boolean> = {
  tip: true,
  update: false,
};

const appStartedAt = Date.now();

/** 任一会话处于忙碌态或正等用户输入。 */
export function isAnySessionBusy(statuses: TerminalStatusType[]): boolean {
  return statuses.some((status) => isBusyStatus(status) || status === "waitingInput");
}

/**
 * 从 store 实时读一次「现在有没有会话在忙」。
 *
 * 供安装前确认使用：更新卡片的**显示**已对 agentBusy 放行，这条路径不能再靠
 * `checkInterruptGate` 拿 `agentBusy`，否则安装前的中断警告会跟着一起失效。
 */
export function hasBusySessions(): boolean {
  return isAnySessionBusy(
    Array.from(useTerminalStatusStore.getState().statusMap.values(), (info) => info.status),
  );
}

export function checkInterruptGate(
  kind: InterruptKind,
  deps: InterruptGateDeps,
): GateBlockReason | null {
  if (AGENT_BUSY_BLOCKS[kind] && isAnySessionBusy(deps.sessionStatuses)) {
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

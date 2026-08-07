import { useCallback } from "react";
import { create } from "zustand";
import {
  useDialogStore,
  useFullscreenStore,
  useMiniModeStore,
  useTerminalStatusStore,
} from "@/stores";
import { isBusyStatus, type TerminalStatusType } from "@/types";

export type InterruptKind = "update" | "tip" | "notice" | "askInput";

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
  // notice/askInput 不参与单槽互斥（useSingleSlot=false），优先级仅为类型完备
  notice: 0,
  askInput: 2,
};

interface GateRuleRow {
  agentBusy: boolean;
  startupGrace: boolean;
  dialogOpen: boolean;
  miniMode: boolean;
  fullscreen: boolean;
  /** 是否参与 update/tip 的单槽互斥；通知栈自管容量，不占槽 */
  useSingleSlot: boolean;
}

/**
 * 闸门规则矩阵：true = 该规则会挡住这类打扰。
 *
 * `tip.agentBusy: true` —— 功能提示在 agent 忙的时候弹正是 docs/58 说的那种烦人，
 * 「tip 系统失败只有一种方式：烦人」。
 *
 * `update.agentBusy: false` —— CC-Panes 的典型用法就是长时间挂着 agent 干活，几乎
 * 总有 busy 会话；若一并挡住，更新卡片不是不显示，而是**永远在等**。放行的只是
 * 「显示卡片」——它在右下角不打断任何操作；真正会杀掉在跑的活的是**安装**，那条
 * 路径另有 `hasBusySessions()` 的确认警告（见 UpdateNotification 的
 * busyAtConfirmation），不受本放行影响。
 *
 * `notice` —— 普通通知（会话事件 / AI 主动通知）：agent 忙时静默入历史 + 未读
 * badge，不弹卡片；被挡 ≠ 丢。
 *
 * `askInput` —— agent 在等用户输入，弹出本身就是目的，几乎全放行：
 * startupGrace 放行（恢复期 waiting_input 常见）、dialogOpen 放行（右下角
 * z-index 低于 dialog 不遮挡）、fullscreen 放行；miniMode 仍挡（没地方渲染，
 * OS 通知兜底）。
 *
 * 规则按 kind 写在这里、不做成调用方传的布尔参数：否则规则散到调用方去，
 * 下一个人不读闸门源码就不知道有这回事。
 */
const GATE_RULES: Record<InterruptKind, GateRuleRow> = {
  update: {
    agentBusy: false,
    startupGrace: true,
    dialogOpen: true,
    miniMode: true,
    fullscreen: true,
    useSingleSlot: true,
  },
  tip: {
    agentBusy: true,
    startupGrace: true,
    dialogOpen: true,
    miniMode: true,
    fullscreen: true,
    useSingleSlot: true,
  },
  notice: {
    agentBusy: true,
    startupGrace: true,
    dialogOpen: true,
    miniMode: true,
    fullscreen: true,
    useSingleSlot: false,
  },
  askInput: {
    agentBusy: false,
    startupGrace: false,
    dialogOpen: false,
    miniMode: true,
    fullscreen: false,
    useSingleSlot: false,
  },
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
  const rules = GATE_RULES[kind];
  if (rules.agentBusy && isAnySessionBusy(deps.sessionStatuses)) {
    return "agentBusy";
  }
  if (rules.startupGrace && deps.now() - deps.appStartedAt < STARTUP_GRACE_MS) {
    return "startupGrace";
  }
  if (rules.dialogOpen && deps.hasOpenDialog) return "dialogOpen";
  if (rules.miniMode && deps.isMiniMode) return "miniMode";
  if (rules.fullscreen && deps.isFullscreen) return "fullscreen";
  if (
    rules.useSingleSlot &&
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

/**
 * 全局 dialog 打开态的唯一 selector。
 * UpdateNotification 曾维护过一份重复列表（漂移风险），统一收敛到这里；
 * 组件内需要响应式订阅时用 `useDialogStore(selectHasOpenDialog)`。
 */
export function selectHasOpenDialog(
  dialogs: ReturnType<typeof useDialogStore.getState>,
): boolean {
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

export function hasOpenDialog(): boolean {
  return selectHasOpenDialog(useDialogStore.getState());
}

export interface InterruptGateController {
  activeInterrupt: InterruptKind | null;
  check: (options?: { ignoreOwnInterrupt?: boolean }) => GateBlockReason | null;
  occupy: () => void;
  release: () => void;
}

/**
 * 非 hook 场景（NotificationCenter 的事件驱动准入）直查实时 store 过闸门。
 * notice/askInput 不占单槽，无需 occupy/release，事件到达时查一次即可。
 */
export function checkInterruptGateLive(
  kind: InterruptKind,
  options?: { ignoreOwnInterrupt?: boolean },
): GateBlockReason | null {
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
}

/** 从真实 store 读取最新状态；调用方可在定时器和点击瞬间重复检查。 */
export function useInterruptGate(kind: InterruptKind): InterruptGateController {
  const activeInterrupt = useInterruptCoordinatorStore((state) => state.activeInterrupt);

  const check = useCallback(
    (options?: { ignoreOwnInterrupt?: boolean }) => checkInterruptGateLive(kind, options),
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

import {
  History,
  MonitorSmartphone,
  ListTodo,
  Bell,
  Server,
  Network,
  type LucideIcon,
} from "lucide-react";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useAiPanelStore } from "@/stores/useAiPanelStore";
import { useDialogStore } from "@/stores/useDialogStore";
import { useDockChatStore } from "@/stores/useDockChatStore";
import { useRightDockStore } from "@/stores/useRightDockStore";
import type { TaskBinding } from "@/types";

export const MODULE_IDS = [
  "ssh",
  "devices",
  "orchestration",
  "todo",
  "aiPanel",
  "sessionHistory",
] as const;

export type ModuleId = (typeof MODULE_IDS)[number];
export type ModulePosition = "activityBar" | "rightDock" | "hidden";
export type ModuleSurface =
  | "activityBar"
  | "rightDock"
  | "settings"
  | "commandPalette"
  | "dialog"
  | "overlay"
  | "fullscreen";
export type ModuleBadge = number | { tone: "red" | "blue" | "amber"; value?: number };

export interface ModuleBadgeContext {
  bindings: readonly TaskBinding[];
  aiPanelUnreadCount?: number;
}

export type BadgeSource = (context: ModuleBadgeContext) => ModuleBadge | undefined;

export interface ModuleDef {
  id: ModuleId;
  icon: LucideIcon;
  titleKey: string;
  surfaces: readonly ModuleSurface[];
  defaultPosition: ModulePosition;
  open: (position: ModulePosition) => void;
  badge?: BadgeSource;
  minimal: boolean;
  configurable?: boolean;
}

function openSsh(position: ModulePosition) {
  if (position === "rightDock") {
    useRightDockStore.setState({ visible: true, activeView: "ssh" });
    return;
  }
  if (position === "activityBar") {
    useActivityBarStore.getState().toggleView("ssh");
    return;
  }
  useActivityBarStore.setState({
    activeView: "ssh",
    sidebarVisible: true,
    appViewMode: "panes",
    orchestrationOverlayOpen: false,
  });
}

function openDevices(position: ModulePosition) {
  if (position === "activityBar") {
    useActivityBarStore.getState().toggleView("devices");
    return;
  }
  useActivityBarStore.setState({
    activeView: "devices",
    sidebarVisible: true,
    appViewMode: "panes",
    orchestrationOverlayOpen: false,
  });
}

function openOrchestration(_position: ModulePosition) {
  const activity = useActivityBarStore.getState();
  activity.closeOrchestrationOverlay();
  useRightDockStore.setState({ visible: true, activeView: "orchestration" });
}

function openTodo(position: ModulePosition) {
  const activity = useActivityBarStore.getState();
  if (position === "activityBar") {
    activity.toggleTodoMode();
    return;
  }
  useActivityBarStore.setState({
    appViewMode: "todo",
    sidebarVisible: true,
    orchestrationOverlayOpen: false,
  });
}

function openAiPanel(position: ModulePosition) {
  if (position === "rightDock") {
    useRightDockStore.setState({ visible: true, activeView: "aiPanel" });
  } else {
    useDialogStore.getState().openAiPanel();
  }
  useAiPanelStore.getState().markActiveRead();
}

/** 会话历史已并进右侧面板对话的历史面板（「终端会话」页）。 */
function openSessionHistory() {
  useRightDockStore.setState({ visible: true, activeView: "chat" });
  useDockChatStore.getState().openHistory("terminal");
}

function orchestrationBadge({ bindings }: ModuleBadgeContext): ModuleBadge | undefined {
  if (bindings.some((binding) => binding.status === "failed")) {
    return { tone: "red" };
  }
  const activeCount = bindings.filter(
    (binding) => binding.status === "running" || binding.status === "waiting",
  ).length;
  return activeCount > 0 ? { tone: "blue", value: activeCount } : undefined;
}

function aiPanelBadge({ aiPanelUnreadCount = 0 }: ModuleBadgeContext): ModuleBadge | undefined {
  return aiPanelUnreadCount > 0
    ? { tone: "amber", value: aiPanelUnreadCount }
    : undefined;
}

export const MODULE_REGISTRY: readonly ModuleDef[] = [
  {
    id: "ssh",
    icon: Server,
    titleKey: "moduleNames.ssh",
    surfaces: ["activityBar", "rightDock"],
    defaultPosition: "activityBar",
    open: openSsh,
    minimal: false,
  },
  {
    id: "devices",
    icon: MonitorSmartphone,
    titleKey: "moduleNames.devices",
    surfaces: ["activityBar"],
    defaultPosition: "activityBar",
    open: openDevices,
    minimal: false,
  },
  {
    id: "orchestration",
    icon: Network,
    titleKey: "moduleNames.orchestration",
    surfaces: ["rightDock", "overlay"],
    defaultPosition: "rightDock",
    open: openOrchestration,
    badge: orchestrationBadge,
    minimal: false,
    configurable: false,
  },
  {
    id: "todo",
    icon: ListTodo,
    titleKey: "moduleNames.todo",
    surfaces: ["activityBar", "rightDock", "fullscreen"],
    defaultPosition: "activityBar",
    open: openTodo,
    minimal: false,
  },
  {
    id: "aiPanel",
    icon: Bell,
    titleKey: "moduleNames.aiPanel",
    surfaces: ["rightDock", "dialog"],
    defaultPosition: "rightDock",
    open: openAiPanel,
    badge: aiPanelBadge,
    minimal: false,
  },
  {
    id: "sessionHistory",
    icon: History,
    titleKey: "moduleNames.sessionHistory",
    surfaces: ["activityBar", "rightDock", "commandPalette", "settings"],
    defaultPosition: "rightDock",
    open: openSessionHistory,
    minimal: false,
  },
];

export const MODULE_CONSUMERS = {
  activityBar: MODULE_REGISTRY,
  contextMenu: MODULE_REGISTRY,
  rightDock: MODULE_REGISTRY,
  settings: MODULE_REGISTRY,
  commandPalette: MODULE_REGISTRY,
} as const;

import {
  Boxes,
  ListTodo,
  Server,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useRightDockStore } from "@/stores/useRightDockStore";
import type { TaskBinding } from "@/types";

export const MODULE_IDS = ["ssh", "orchestration", "resources", "todo"] as const;

export type ModuleId = (typeof MODULE_IDS)[number];
export type ModulePosition = "activityBar" | "rightDock" | "hidden";
export type ModuleSurface = "activityBar" | "rightDock" | "overlay" | "fullscreen";
export type ModuleBadge = number | { tone: "red" | "blue"; value?: number };

export interface ModuleBadgeContext {
  bindings: readonly TaskBinding[];
}

export type BadgeSource = (context: ModuleBadgeContext) => ModuleBadge | undefined;

export interface ModuleDef {
  id: ModuleId;
  icon: LucideIcon;
  titleKey: string;
  surfaces: readonly ModuleSurface[];
  defaultPosition: "activityBar";
  open: (position: ModulePosition) => void;
  badge?: BadgeSource;
  minimal: boolean;
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

function openOrchestration(position: ModulePosition) {
  const activity = useActivityBarStore.getState();
  if (position === "activityBar") {
    activity.toggleView("orchestration");
    return;
  }
  activity.openOrchestrationOverlay();
}

function openResources(position: ModulePosition) {
  const activity = useActivityBarStore.getState();
  if (position === "activityBar") {
    activity.toggleResourcesMode();
    return;
  }
  activity.setAppViewMode("resources");
}

function openTodo(position: ModulePosition) {
  const activity = useActivityBarStore.getState();
  if (position === "activityBar") {
    activity.toggleTodoMode();
    return;
  }
  activity.setAppViewMode("todo");
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
    id: "orchestration",
    icon: Workflow,
    titleKey: "moduleNames.orchestration",
    surfaces: ["activityBar", "rightDock", "overlay"],
    defaultPosition: "activityBar",
    open: openOrchestration,
    badge: orchestrationBadge,
    minimal: false,
  },
  {
    id: "resources",
    icon: Boxes,
    titleKey: "moduleNames.resources",
    surfaces: ["activityBar", "rightDock", "fullscreen"],
    defaultPosition: "activityBar",
    open: openResources,
    minimal: false,
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
];

export const MODULE_CONSUMERS = {
  activityBar: MODULE_REGISTRY,
  contextMenu: MODULE_REGISTRY,
  rightDock: MODULE_REGISTRY,
  settings: MODULE_REGISTRY,
  commandPalette: MODULE_REGISTRY,
} as const;

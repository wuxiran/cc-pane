// 右侧面板竖栏的视图清单（顺序即 ⌘⌥1..N 的编号）。RightDock 渲染竖栏与快捷键命令
// 共用这一份推导，保证提示里写的编号和按下去切到的视图永远一致。
import { MODULE_CONSUMERS, type ModuleDef } from "@/modules/registry";
import { useModulePrefsStore, type ModulePreferences } from "@/stores/useModulePrefsStore";
import { useRightDockStore, type RightDockView } from "@/stores/useRightDockStore";
import { useSshRemoteFilesStore } from "@/stores/useSshRemoteFilesStore";

/** 会话历史并进了对话视图的历史面板，不再单独占竖栏一格。 */
export const MODULES_MERGED_INTO_CHAT = new Set<string>(["sessionHistory"]);

/** 竖栏快捷键的命令 id 前缀；编号从 1 起。 */
export const DOCK_VIEW_COMMAND_PREFIX = "focus-dock-view-";
export const DOCK_VIEW_SHORTCUT_COUNT = 9;
export const TOGGLE_RIGHT_DOCK_COMMAND = "toggle-right-dock";

export type DockRailView =
  | { kind: "builtin"; id: Extract<RightDockView, "chat" | "files" | "git" | "sshFiles"> }
  | { kind: "module"; id: string; module: ModuleDef };

/** 挂在右侧面板的模块（含固定在这里的编排）。 */
export function resolveDockModules(preferences: ModulePreferences): ModuleDef[] {
  return MODULE_CONSUMERS.rightDock.filter((module) => {
    const preference = preferences[module.id];
    const fixedRightDock = module.id === "orchestration";
    return (fixedRightDock || preference.enabled)
      && (fixedRightDock || preference.position === "rightDock")
      && module.surfaces.includes("rightDock");
  });
}

export function resolveDockRailViews(dockModules: readonly ModuleDef[], remoteMachineId: string | null): DockRailView[] {
  return [
    { kind: "builtin", id: "chat" },
    { kind: "builtin", id: "files" },
    { kind: "builtin", id: "git" },
    ...(remoteMachineId ? [{ kind: "builtin" as const, id: "sshFiles" as const }] : []),
    ...dockModules
      .filter((module) => !MODULES_MERGED_INTO_CHAT.has(module.id))
      .map((module): DockRailView => ({ kind: "module", id: module.id, module })),
  ];
}

/** 切到某个竖栏视图（面板收着时一并展开）。 */
export function openDockRailView(view: DockRailView): void {
  if (view.kind === "module") {
    view.module.open("rightDock");
    return;
  }
  useRightDockStore.setState({ visible: true, activeView: view.id });
}

/** 快捷键入口：按当前竖栏顺序取第 index 个（从 0 起）；超出范围静默忽略。 */
export function openDockRailViewAt(index: number): boolean {
  const views = resolveDockRailViews(
    resolveDockModules(useModulePrefsStore.getState().preferences),
    useSshRemoteFilesStore.getState().machineId,
  );
  const view = views[index];
  if (!view) return false;
  openDockRailView(view);
  return true;
}

export function dockViewCommandId(index: number): string {
  return `${DOCK_VIEW_COMMAND_PREFIX}${index + 1}`;
}

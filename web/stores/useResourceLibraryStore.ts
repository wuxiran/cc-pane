// 资源库的当前子页和作用域。所有入口都走 openResourceLibrary，设置窗口里转发到主窗口。
import { create } from "zustand";
import { isSettingsWindow, sendActionToMainWindow } from "@/services/settingsWindowService";
import type { McpLayerTarget } from "@/types";
import type { ResourceSection } from "@/types/resourceLibrary";
import { useActivityBarStore } from "./useActivityBarStore";

interface ResourceLibraryState {
  section: ResourceSection;
  /** 工作空间或项目；null 表示只看全局资源 */
  scope: McpLayerTarget | null;
  setSection: (section: ResourceSection) => void;
  setScope: (scope: McpLayerTarget | null) => void;
}

export const useResourceLibraryStore = create<ResourceLibraryState>((set) => ({
  section: "mcp",
  scope: null,
  setSection: (section) => set({ section }),
  setScope: (scope) => set({ scope }),
}));

/** 打开资源库；scope 不传时保留当前选择。 */
export function openResourceLibrary(section: ResourceSection, scope?: McpLayerTarget | null): void {
  if (isSettingsWindow()) {
    void sendActionToMainWindow({ type: "openResourceLibrary", section, scope: scope ?? null });
    return;
  }
  const store = useResourceLibraryStore.getState();
  store.setSection(section);
  if (scope !== undefined) store.setScope(scope);
  const activity = useActivityBarStore.getState();
  if (activity.appViewMode !== "resources") activity.toggleResourcesMode();
}

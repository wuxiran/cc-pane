import type { ComponentType } from "react";
import { navigateToSettings } from "@/components/settings/settingsNavigation";
import { MODULE_REGISTRY, type ModuleId } from "@/modules/registry";
import {
  useActivityBarStore,
  useDialogStore,
  useModulePrefsStore,
  useRightDockStore,
  useShortcutsStore,
  useWorkspacesStore,
} from "@/stores";
import { detectAppPlatform, isTauriRuntime } from "@/utils";
import {
  AiPanelVisual,
  BrowserTabVisual,
  CommandPaletteVisual,
  DispatchOrchestrationVisual,
  InterfaceShapesVisual,
  LauncherVisual,
  LayoutSwitcherVisual,
  MiniModeVisual,
  RightDockVisual,
  WorktreeIsolationVisual,
} from "./featureTipVisuals";

export interface FeatureTipDefinition {
  id: string;
  actionId?: string;
  titleKey: string;
  bodyKey: string;
  bodyUnboundKey?: string;
  actionLabelKey?: string;
  /**
   * 落点教程，仓库相对路径（如 `docs/guide/12-leader-worker.md`）。
   * 渲染成左栏的「查看教程」链接，打开方式见 openGuideDoc.ts。
   */
  guidePath?: string;
  visual: ComponentType;
  tryAction?: () => void;
  eligible?: () => boolean;
  weight?: number;
}

function runShortcutAction(actionId: string): void {
  useShortcutsStore.getState().actions.get(actionId)?.handler();
}

function hasShortcutAction(actionId: string): boolean {
  return useShortcutsStore.getState().actions.has(actionId);
}

function isModuleEnabled(id: ModuleId): boolean {
  return useModulePrefsStore.getState().preferences[id]?.enabled === true;
}

/**
 * tip 的「当前项目」：显式选中的项目 > 展开工作空间的首个项目 > 首个有项目的工作空间。
 * 与右侧坞的纵深解析同思路，但不依赖终端选区——tip 触发时可能一个终端都没开。
 */
export function resolveTipProjectPath(): string | null {
  const { workspaces, expandedWorkspaceId, expandedProjectId } = useWorkspacesStore.getState();
  for (const workspace of workspaces) {
    const selected = workspace.projects.find((project) => project.id === expandedProjectId);
    if (selected) return selected.path;
  }
  const expanded = workspaces.find((workspace) => workspace.id === expandedWorkspaceId);
  if (expanded?.projects[0]) return expanded.projects[0].path;
  return workspaces.find((workspace) => workspace.projects.length > 0)?.projects[0]?.path ?? null;
}

function hasAnyProject(): boolean {
  return resolveTipProjectPath() !== null;
}

function openWorktreeManagerForCurrentProject(): void {
  const projectPath = resolveTipProjectPath();
  if (!projectPath) return;
  // 对话框挂在侧栏树里，先把侧栏亮出来再下请求，否则消费方没挂载。
  useActivityBarStore.setState({
    appViewMode: "panes",
    activeView: "explorer",
    sidebarVisible: true,
    orchestrationOverlayOpen: false,
  });
  useDialogStore.getState().requestWorktreeManager(projectPath);
}

function openAiPanelModule(): void {
  const module = MODULE_REGISTRY.find((entry) => entry.id === "aiPanel");
  // 按用户配置的位置打开：右侧坞 / 弹框，「隐藏」时也走弹框，保证点了必有反馈。
  module?.open(useModulePrefsStore.getState().preferences.aiPanel.position);
}

function openOrchestrationModule(): void {
  MODULE_REGISTRY.find((module) => module.id === "orchestration")?.open("rightDock");
}

function shortcutTip(
  definition: Omit<FeatureTipDefinition, "tryAction" | "eligible"> & { actionId: string },
): FeatureTipDefinition {
  return {
    ...definition,
    tryAction: () => runShortcutAction(definition.actionId),
    eligible: () => hasShortcutAction(definition.actionId),
  };
}

export const FEATURE_TIPS: readonly FeatureTipDefinition[] = [
  shortcutTip({
    id: "command-palette",
    actionId: "command-palette",
    titleKey: "featureTips.commandPalette.title",
    bodyKey: "featureTips.commandPalette.body",
    bodyUnboundKey: "featureTips.commandPalette.bodyUnbound",
    visual: CommandPaletteVisual,
    weight: 3,
  }),
  shortcutTip({
    id: "layout-switcher",
    actionId: "toggle-layouts",
    titleKey: "featureTips.layoutSwitcher.title",
    bodyKey: "featureTips.layoutSwitcher.body",
    bodyUnboundKey: "featureTips.layoutSwitcher.bodyUnbound",
    guidePath: "docs/guide/05-terminal-and-panes.md",
    visual: LayoutSwitcherVisual,
    weight: 2,
  }),
  {
    id: "interface-shapes",
    titleKey: "featureTips.interfaceShapes.title",
    bodyKey: "featureTips.interfaceShapes.body",
    actionLabelKey: "featureTips.interfaceShapes.action",
    visual: InterfaceShapesVisual,
    tryAction: () => navigateToSettings({
      paneId: "theme",
      targetSectionId: "theme-shape",
    }),
    weight: 2,
  },
  shortcutTip({
    id: "mini-mode",
    actionId: "toggle-mini-mode",
    titleKey: "featureTips.miniMode.title",
    bodyKey: "featureTips.miniMode.body",
    bodyUnboundKey: "featureTips.miniMode.bodyUnbound",
    visual: MiniModeVisual,
    weight: 1,
  }),
  shortcutTip({
    id: "unified-launcher",
    actionId: "new-tab",
    titleKey: "featureTips.launcher.title",
    bodyKey: "featureTips.launcher.body",
    bodyUnboundKey: "featureTips.launcher.bodyUnbound",
    guidePath: "docs/guide/05-terminal-and-panes.md",
    visual: LauncherVisual,
    weight: 2,
  }),
  {
    id: "dispatch-orchestration",
    titleKey: "featureTips.dispatchOrchestration.title",
    bodyKey: "featureTips.dispatchOrchestration.body",
    guidePath: "docs/guide/12-leader-worker.md",
    visual: DispatchOrchestrationVisual,
    // 任务编排面板就是盯 worker 的地方；没有项目就没有可派的活。
    tryAction: openOrchestrationModule,
    eligible: () => isModuleEnabled("orchestration") && hasAnyProject(),
    weight: 4,
  },
  {
    id: "worktree-isolation",
    titleKey: "featureTips.worktreeIsolation.title",
    bodyKey: "featureTips.worktreeIsolation.body",
    guidePath: "docs/guide/07-git-worktree.md",
    visual: WorktreeIsolationVisual,
    tryAction: openWorktreeManagerForCurrentProject,
    eligible: hasAnyProject,
    weight: 3,
  },
  {
    id: "ai-panel",
    titleKey: "featureTips.aiPanel.title",
    bodyKey: "featureTips.aiPanel.body",
    guidePath: "docs/guide/17-ai-panel.md",
    visual: AiPanelVisual,
    tryAction: openAiPanelModule,
    eligible: () => isModuleEnabled("aiPanel"),
    weight: 2,
  },
  {
    id: "right-dock",
    titleKey: "featureTips.rightDock.title",
    bodyKey: "featureTips.rightDock.body",
    guidePath: "docs/guide/19-right-dock.md",
    visual: RightDockVisual,
    // 直接改 store：右坞既没有快捷键，命令面板那条路又被 Ctrl+K 放行挡着。
    tryAction: () => useRightDockStore.getState().setVisible(true),
    eligible: hasAnyProject,
    weight: 1,
  },
  {
    id: "browser-tab",
    titleKey: "featureTips.browserTab.title",
    bodyKey: "featureTips.browserTab.body",
    guidePath: "docs/guide/20-browser-tab.md",
    visual: BrowserTabVisual,
    // 没有 tryAction：用户没有任何打开浏览器标签的入口（唯一调用点是 MCP 事件监听），
    // 放一个"替你开一个"的按钮等于教一个用户复现不了的动作。
    eligible: () => isTauriRuntime() && detectAppPlatform() === "windows",
    weight: 1,
  },
];

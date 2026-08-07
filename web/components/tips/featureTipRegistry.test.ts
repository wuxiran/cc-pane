import { beforeEach, describe, expect, it, vi } from "vitest";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useDialogStore } from "@/stores/useDialogStore";
import {
  createDefaultModulePreferences,
  useModulePrefsStore,
} from "@/stores/useModulePrefsStore";
import { useRightDockStore } from "@/stores/useRightDockStore";
import { useWorkspacesStore } from "@/stores/useWorkspacesStore";
import type { Workspace } from "@/types";
import { SETTINGS_NAVIGATE_EVENT } from "@/components/settings/settingsNavigation";
import { FEATURE_TIPS, resolveTipProjectPath } from "./featureTipRegistry";

const workspace: Workspace = {
  id: "workspace-1",
  name: "Workspace One",
  createdAt: "2026-07-24T00:00:00Z",
  projects: [
    { id: "project-1", path: "/workspace/alpha", alias: "Alpha" },
    { id: "project-2", path: "/workspace/beta", alias: "Beta" },
  ],
};

function tip(id: string) {
  const definition = FEATURE_TIPS.find((entry) => entry.id === id);
  if (!definition) throw new Error(`missing feature tip: ${id}`);
  return definition;
}

function setPlatform(value: string): void {
  Object.defineProperty(window.navigator, "platform", { value, configurable: true });
}

describe("扩容的六条 tip", () => {
  beforeEach(() => {
    useWorkspacesStore.setState({
      workspaces: [workspace],
      expandedWorkspaceId: null,
      expandedProjectId: null,
    });
    useModulePrefsStore.setState({ preferences: createDefaultModulePreferences() });
    useActivityBarStore.setState({
      appViewMode: "home",
      activeView: "explorer",
      sidebarVisible: true,
      orchestrationOverlayOpen: false,
      resourcesTab: "providers",
    });
    useDialogStore.setState({ worktreeManagerRequestPath: null, aiPanelOpen: false });
    useRightDockStore.setState({ visible: false, activeView: "git" });
  });

  it("六条都带落点教程链接，且都不挂 actionId", () => {
    const ids = [
      "dispatch-orchestration",
      "worktree-isolation",
      "ai-panel",
      "skills",
      "right-dock",
      "browser-tab",
    ];
    for (const id of ids) {
      expect(tip(id).guidePath, id).toMatch(/^docs\/guide\/.+\.md$/);
      expect(tip(id).actionId, id).toBeUndefined();
    }
  });

  it("派工编排：试试看打开右侧坞任务编排；模块关掉或没有项目时不候选", () => {
    expect(tip("dispatch-orchestration").eligible?.()).toBe(true);

    tip("dispatch-orchestration").tryAction?.();
    expect(useActivityBarStore.getState().orchestrationOverlayOpen).toBe(false);
    expect(useRightDockStore.getState()).toMatchObject({
      visible: true,
      activeView: "orchestration",
    });

    useWorkspacesStore.setState({ workspaces: [{ ...workspace, projects: [] }] });
    expect(tip("dispatch-orchestration").eligible?.()).toBe(false);

    useWorkspacesStore.setState({ workspaces: [workspace] });
    const preferences = useModulePrefsStore.getState().preferences;
    useModulePrefsStore.setState({
      preferences: {
        ...preferences,
        orchestration: { ...preferences.orchestration, enabled: false },
      },
    });
    expect(tip("dispatch-orchestration").eligible?.()).toBe(false);
  });

  it("worktree 隔离：试试看亮出侧栏并对当前项目请求 Worktree 管理", () => {
    expect(tip("worktree-isolation").eligible?.()).toBe(true);

    useWorkspacesStore.setState({ expandedProjectId: "project-2" });
    tip("worktree-isolation").tryAction?.();

    expect(useDialogStore.getState().worktreeManagerRequestPath).toBe("/workspace/beta");
    expect(useActivityBarStore.getState().sidebarVisible).toBe(true);
    expect(useActivityBarStore.getState().activeView).toBe("explorer");
    expect(useActivityBarStore.getState().appViewMode).toBe("panes");

    useWorkspacesStore.setState({ workspaces: [], expandedProjectId: null });
    expect(tip("worktree-isolation").eligible?.()).toBe(false);
  });

  it("AI 面板：默认位置在右侧坞时试试看直接把它亮出来", () => {
    expect(tip("ai-panel").eligible?.()).toBe(true);

    tip("ai-panel").tryAction?.();
    expect(useRightDockStore.getState().visible).toBe(true);
    expect(useRightDockStore.getState().activeView).toBe("aiPanel");

    const preferences = useModulePrefsStore.getState().preferences;
    useModulePrefsStore.setState({
      preferences: { ...preferences, aiPanel: { ...preferences.aiPanel, enabled: false } },
    });
    expect(tip("ai-panel").eligible?.()).toBe(false);
  });

  it("AI 面板位置设为隐藏时降级为弹框，不会点了没反应", () => {
    const preferences = useModulePrefsStore.getState().preferences;
    useModulePrefsStore.setState({
      preferences: { ...preferences, aiPanel: { ...preferences.aiPanel, position: "hidden" } },
    });

    tip("ai-panel").tryAction?.();

    expect(useDialogStore.getState().aiPanelOpen).toBe(true);
    expect(useRightDockStore.getState().visible).toBe(false);
  });

  it("skill：试试看直达资源中心的 Skills 页（完整清单所在），不是只有四项的运行配置勾选清单", () => {
    expect(tip("skills").eligible?.()).toBe(true);

    tip("skills").tryAction?.();
    expect(useActivityBarStore.getState().appViewMode).toBe("resources");
    expect(useActivityBarStore.getState().resourcesTab).toBe("skills");

    const preferences = useModulePrefsStore.getState().preferences;
    useModulePrefsStore.setState({
      preferences: { ...preferences, resources: { ...preferences.resources, enabled: false } },
    });
    expect(tip("skills").eligible?.()).toBe(false);
  });

  it("右坞：试试看直接改 store 打开，不依赖快捷键分发", () => {
    expect(tip("right-dock").eligible?.()).toBe(true);

    tip("right-dock").tryAction?.();
    expect(useRightDockStore.getState().visible).toBe(true);

    useWorkspacesStore.setState({ workspaces: [{ ...workspace, projects: [] }] });
    expect(tip("right-dock").eligible?.()).toBe(false);
  });

  it("浏览器标签：没有主行动，且非 Windows 下不候选", () => {
    expect(tip("browser-tab").tryAction).toBeUndefined();

    const original = window.navigator.platform;
    const internals = window.__TAURI_INTERNALS__;
    try {
      window.__TAURI_INTERNALS__ = {} as typeof window.__TAURI_INTERNALS__;
      setPlatform("Win32");
      expect(tip("browser-tab").eligible?.()).toBe(true);

      setPlatform("MacIntel");
      expect(tip("browser-tab").eligible?.()).toBe(false);

      setPlatform("Linux x86_64");
      expect(tip("browser-tab").eligible?.()).toBe(false);

      // 桌面壳之外（Web 端）连浏览器标签本身都不可用
      window.__TAURI_INTERNALS__ = undefined;
      setPlatform("Win32");
      expect(tip("browser-tab").eligible?.()).toBe(false);
    } finally {
      window.__TAURI_INTERNALS__ = internals;
      setPlatform(original);
    }
  });

  it("当前项目解析：选中项 > 展开工作空间首个 > 首个有项目的工作空间", () => {
    expect(resolveTipProjectPath()).toBe("/workspace/alpha");

    useWorkspacesStore.setState({ expandedProjectId: "project-2" });
    expect(resolveTipProjectPath()).toBe("/workspace/beta");

    useWorkspacesStore.setState({
      workspaces: [{ ...workspace, projects: [] }, { ...workspace, id: "workspace-2" }],
      expandedProjectId: null,
    });
    expect(resolveTipProjectPath()).toBe("/workspace/alpha");

    useWorkspacesStore.setState({ workspaces: [] });
    expect(resolveTipProjectPath()).toBeNull();
  });

  it("最贵的两条权重更高：派工编排 > worktree > 其余新条目", () => {
    expect(tip("dispatch-orchestration").weight).toBeGreaterThan(tip("worktree-isolation").weight!);
    expect(tip("worktree-isolation").weight).toBeGreaterThan(tip("right-dock").weight!);
  });
});

describe("试试看不会在缺前置条件时静默无反应", () => {
  it("没有项目时 worktree 的试试看不下发请求", () => {
    useWorkspacesStore.setState({ workspaces: [], expandedProjectId: null });
    useDialogStore.setState({ worktreeManagerRequestPath: null });
    const spy = vi.spyOn(useDialogStore.getState(), "requestWorktreeManager");

    tip("worktree-isolation").tryAction?.();

    expect(spy).not.toHaveBeenCalled();
    expect(tip("worktree-isolation").eligible?.()).toBe(false);
    spy.mockRestore();
  });
});

describe("界面形态 tip", () => {
  beforeEach(() => {
    useDialogStore.setState({ settingsOpen: false });
  });

  it("打开主题设置的形态区域", () => {
    const navigate = vi.fn();
    window.addEventListener(SETTINGS_NAVIGATE_EVENT, navigate);

    tip("interface-shapes").tryAction?.();

    expect(useDialogStore.getState().settingsOpen).toBe(true);
    expect(navigate).toHaveBeenCalledOnce();
    expect((navigate.mock.calls[0][0] as CustomEvent).detail).toEqual({
      paneId: "theme",
      targetSectionId: "theme-shape",
    });
    window.removeEventListener(SETTINGS_NAVIGATE_EVENT, navigate);
  });
});

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { usePanesStore, useWorkspacesStore } from "@/stores";
import type { Panel, Tab, Workspace } from "@/types";
import {
  resolveTerminalContextSelection,
  useFollowActiveTerminalContext,
} from "./useFollowActiveTerminalContext";

function makeTab(
  id: string,
  projectPath: string,
  workspaceName?: string,
): Tab {
  return {
    id,
    title: id,
    contentType: "terminal",
    projectId: `runtime-${id}`,
    projectPath,
    sessionId: null,
    workspaceName,
  };
}

function makePanel(tabs: Tab[], activeTabId: string): Panel {
  return {
    type: "panel",
    id: "pane-1",
    tabs,
    activeTabId,
  };
}

const workspaceA: Workspace = {
  id: "workspace-a",
  name: "alpha",
  createdAt: "2026-07-24T00:00:00Z",
  projects: [{ id: "project-a", path: "D:\\Repos\\Alpha" }],
};

const workspaceB: Workspace = {
  id: "workspace-b",
  name: "beta",
  createdAt: "2026-07-24T00:00:00Z",
  projects: [{ id: "project-b", path: "D:\\Repos\\Beta" }],
};

function setActivePanel(panel: Panel): void {
  usePanesStore.setState({
    rootPane: panel,
    activePaneId: panel.id,
  });
}

describe("useFollowActiveTerminalContext", () => {
  beforeEach(() => {
    useWorkspacesStore.setState({
      workspaces: [workspaceA, workspaceB],
      expandedWorkspaceId: null,
      expandedProjectId: null,
    });
  });

  it("SSH 终端 tab 不跟随工作空间选中", () => {
    setActivePanel(makePanel([
      {
        ...makeTab("tab-ssh", "ssh://dev@example.com/home/dev"),
        ssh: {
          host: "example.com",
          port: 22,
          remotePath: "/home/dev",
          machineId: "machine-1",
        },
      },
    ], "tab-ssh"));

    renderHook(() => useFollowActiveTerminalContext());

    expect(useWorkspacesStore.getState()).toMatchObject({
      expandedWorkspaceId: null,
      expandedProjectId: null,
    });
  });

  it("激活终端 tab 时同步工作空间和项目", () => {
    setActivePanel(makePanel([
      makeTab("tab-a", "D:\\Repos\\Alpha", "alpha"),
    ], "tab-a"));

    renderHook(() => useFollowActiveTerminalContext());

    expect(useWorkspacesStore.getState()).toMatchObject({
      expandedWorkspaceId: "workspace-a",
      expandedProjectId: "project-a",
    });
  });

  it("纯 shell tab 没有项目路径时保持当前选中", () => {
    useWorkspacesStore.setState({
      expandedWorkspaceId: "workspace-b",
      expandedProjectId: "project-b",
    });
    setActivePanel(makePanel([makeTab("shell", "")], "shell"));

    renderHook(() => useFollowActiveTerminalContext());

    expect(useWorkspacesStore.getState()).toMatchObject({
      expandedWorkspaceId: "workspace-b",
      expandedProjectId: "project-b",
    });
  });

  it("当前已是同一项目时不重复写 store", () => {
    useWorkspacesStore.setState({
      expandedWorkspaceId: "workspace-a",
      expandedProjectId: "project-a",
    });
    setActivePanel(makePanel([
      makeTab("tab-a", "D:\\Repos\\Alpha", "alpha"),
    ], "tab-a"));
    let writes = 0;
    const unsubscribe = useWorkspacesStore.subscribe(() => {
      writes += 1;
    });

    renderHook(() => useFollowActiveTerminalContext());

    unsubscribe();
    expect(writes).toBe(0);
  });

  it("跨工作空间切换 tab 时同时切换工作空间和项目", () => {
    const panel = makePanel([
      makeTab("tab-a", "D:\\Repos\\Alpha", "alpha"),
      makeTab("tab-b", "D:\\Repos\\Beta", "beta"),
    ], "tab-a");
    setActivePanel(panel);
    renderHook(() => useFollowActiveTerminalContext());

    act(() => {
      usePanesStore.getState().selectTab(panel.id, "tab-b");
    });

    expect(useWorkspacesStore.getState()).toMatchObject({
      expandedWorkspaceId: "workspace-b",
      expandedProjectId: "project-b",
    });
  });

  it("同一 tab 激活后尊重用户的最后手动选择，不因工作区刷新再覆盖", () => {
    setActivePanel(makePanel([
      makeTab("tab-a", "D:\\Repos\\Alpha", "alpha"),
    ], "tab-a"));
    renderHook(() => useFollowActiveTerminalContext());

    act(() => {
      useWorkspacesStore.setState({
        expandedWorkspaceId: "workspace-b",
        expandedProjectId: "project-b",
      });
      useWorkspacesStore.setState({ workspaces: [workspaceA, workspaceB] });
    });

    expect(useWorkspacesStore.getState()).toMatchObject({
      expandedWorkspaceId: "workspace-b",
      expandedProjectId: "project-b",
    });
  });
});

describe("resolveTerminalContextSelection", () => {
  it("使用 canonical 项目身份命中 Windows、WSL mount 与 WSL UNC 等价路径", () => {
    expect(resolveTerminalContextSelection(
      { projectPath: "/mnt/d/repos/alpha/", workspaceName: "alpha" },
      [workspaceA],
    )).toEqual({ workspaceId: "workspace-a", projectId: "project-a" });

    expect(resolveTerminalContextSelection(
      {
        projectPath: "\\\\wsl.localhost\\Ubuntu-24.04\\mnt\\d\\REPOS\\ALPHA",
        workspaceName: "alpha",
      },
      [workspaceA],
    )).toEqual({ workspaceId: "workspace-a", projectId: "project-a" });
  });

  it("同一路径出现在多个工作空间时优先 workspaceName", () => {
    const duplicate: Workspace = {
      ...workspaceA,
      id: "workspace-duplicate",
      name: "duplicate",
      projects: [{ id: "project-duplicate", path: "/mnt/d/Repos/Alpha" }],
    };

    expect(resolveTerminalContextSelection(
      { projectPath: "D:/Repos/Alpha", workspaceName: "duplicate" },
      [workspaceA, duplicate],
    )).toEqual({
      workspaceId: "workspace-duplicate",
      projectId: "project-duplicate",
    });
  });
});

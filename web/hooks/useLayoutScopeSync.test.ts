import { beforeEach, describe, expect, it } from "vitest";
import { usePanesStore } from "@/stores/usePanesStore";
import { useLayoutScopeStore } from "@/stores/useLayoutScopeStore";
import { createPanel } from "@/lib/paneTree";
import {
  resolveLayoutScopeForSync,
  switchLayoutScope,
} from "./useLayoutScopeSync";
import type { Tab, Workspace } from "@/types";

const workspace = (id: string, name = id): Workspace => ({
  id,
  name,
  createdAt: "2024-01-01T00:00:00.000Z",
  projects: [{ id: `${id}-project`, path: `/${id}` }],
});

const tab = (patch: Partial<Tab> = {}): Tab => ({
  id: "tab-1",
  title: "Terminal",
  contentType: "terminal",
  projectId: "",
  projectPath: "",
  sessionId: null,
  ...patch,
});

describe("useLayoutScopeSync", () => {
  it("普通 workspace 使用 workspace scope", () => {
    expect(resolveLayoutScopeForSync({
      workspaceId: "workspace-1",
      workspace: workspace("workspace-1"),
      activeTab: tab(),
      selectedMachineId: null,
      fallbackMachineId: null,
      sshViewActive: false,
      explicitWorkspaceChanged: false,
    })).toBe("workspace:workspace-1");
  });

  it("SSH tab 使用 machine scope", () => {
    expect(resolveLayoutScopeForSync({
      workspaceId: "workspace-1",
      workspace: workspace("workspace-1"),
      activeTab: tab({ ssh: {
        host: "host",
        port: 22,
        remotePath: "/home/user",
        machineId: "machine-1",
      } }),
      selectedMachineId: null,
      fallbackMachineId: null,
      sshViewActive: false,
      explicitWorkspaceChanged: false,
    })).toBe("ssh-machine:machine-1");
  });

  it("SSH 侧栏未点选时回退到第一台机器", () => {
    expect(resolveLayoutScopeForSync({
      workspaceId: "workspace-1",
      workspace: workspace("workspace-1"),
      activeTab: tab(),
      selectedMachineId: null,
      fallbackMachineId: "machine-1",
      sshViewActive: true,
      explicitWorkspaceChanged: false,
    })).toBe("ssh-machine:machine-1");
  });

  it("SSH 侧栏选中机器时使用 machine scope", () => {
    expect(resolveLayoutScopeForSync({
      workspaceId: "workspace-1",
      workspace: workspace("workspace-1"),
      activeTab: tab(),
      selectedMachineId: "machine-1",
      fallbackMachineId: null,
      sshViewActive: true,
      explicitWorkspaceChanged: false,
    })).toBe("ssh-machine:machine-1");
  });

  it("显式 workspace 变化时不让不匹配的旧 SSH tab 抢回 scope", () => {
    expect(resolveLayoutScopeForSync({
      workspaceId: "workspace-2",
      workspace: workspace("workspace-2"),
      activeTab: tab({
        projectId: "workspace-1-project",
        ssh: {
          host: "host",
          port: 22,
          remotePath: "/home/user",
          machineId: "machine-1",
        },
      }),
      selectedMachineId: null,
      fallbackMachineId: null,
      sshViewActive: false,
      explicitWorkspaceChanged: true,
    })).toBe("workspace:workspace-2");
  });

  it("没有 workspace 上下文时回退 default", () => {
    expect(resolveLayoutScopeForSync({
      workspaceId: null,
      workspace: undefined,
      activeTab: tab(),
      selectedMachineId: null,
      fallbackMachineId: null,
      sshViewActive: false,
      explicitWorkspaceChanged: false,
    })).toBe("workspace:default");
  });
});

describe("switchLayoutScope", () => {
  beforeEach(() => {
    useLayoutScopeStore.getState().resetForTest();
    const rootPane = createPanel();
    rootPane.tabs = [{
      id: "ws-tab",
      title: "workspace tab",
      contentType: "terminal",
      projectId: "project-1",
      projectPath: "/workspace",
      sessionId: "sess-1",
    }];
    rootPane.activeTabId = "ws-tab";
    usePanesStore.setState({
      layouts: [{
        id: "layout-ws",
        name: "布局 1",
        kind: "normal",
        workspaceName: "Trust",
        rootPane,
        activePaneId: rootPane.id,
      }],
      currentLayoutId: "layout-ws",
      rootPane,
      activePaneId: rootPane.id,
    });
  });

  it("新 SSH scope 使用独立空布局而不是克隆工作空间 tabs", () => {
    switchLayoutScope("ssh-machine:machine-1");

    expect(useLayoutScopeStore.getState().activeScope).toBe("ssh-machine:machine-1");
    const panes = usePanesStore.getState();
    expect(panes.currentLayoutId).not.toBe("layout-ws");
    expect(panes.rootPane.type).toBe("panel");
    if (panes.rootPane.type === "panel") {
      expect(panes.rootPane.tabs).toEqual([]);
    }
    const workspacePayload = useLayoutScopeStore.getState().getScope("workspace:default");
    expect(workspacePayload?.layouts.some((layout) => (
      layout.rootPane.type === "panel" && layout.rootPane.tabs.some((item) => item.id === "ws-tab")
    ))).toBe(true);
  });
});

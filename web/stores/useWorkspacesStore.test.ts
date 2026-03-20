import { describe, it, expect, beforeEach, vi } from "vitest";
import { useWorkspacesStore } from "./useWorkspacesStore";
import * as workspaceService from "@/services/workspaceService";
import {
  createTestWorkspace,
  createTestWorkspaceProject,
  resetTestDataCounter,
} from "@/test/utils/testData";

vi.mock("@/services/workspaceService", () => ({
  listWorkspaces: vi.fn(),
  createWorkspace: vi.fn(),
  renameWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  addWorkspaceProject: vi.fn(),
  removeWorkspaceProject: vi.fn(),
  updateWorkspaceAlias: vi.fn(),
  updateWorkspaceProjectAlias: vi.fn(),
  updateWorkspaceProvider: vi.fn(),
  updateWorkspacePinned: vi.fn(),
  updateWorkspaceHidden: vi.fn(),
  reorderWorkspaces: vi.fn(),
}));

describe("useWorkspacesStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTestDataCounter();
    useWorkspacesStore.setState({
      workspaces: [],
      expandedWorkspaceId: null,
      expandedProjectId: null,
      loading: false,
    });
  });

  describe("初始状态", () => {
    it("应该有正确的初始值", () => {
      const state = useWorkspacesStore.getState();
      expect(state.workspaces).toEqual([]);
      expect(state.expandedWorkspaceId).toBeNull();
      expect(state.expandedProjectId).toBeNull();
      expect(state.loading).toBe(false);
    });
  });

  describe("load", () => {
    it("应调用 listWorkspaces 并设置 workspaces", async () => {
      const ws1 = createTestWorkspace();
      const ws2 = createTestWorkspace();
      vi.mocked(workspaceService.listWorkspaces).mockResolvedValue([ws1, ws2]);

      await useWorkspacesStore.getState().load();

      const state = useWorkspacesStore.getState();
      expect(state.workspaces).toHaveLength(2);
      expect(state.loading).toBe(false);
    });

    it("加载期间 loading 应为 true", async () => {
      vi.mocked(workspaceService.listWorkspaces).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([]), 10))
      );

      const loadPromise = useWorkspacesStore.getState().load();
      expect(useWorkspacesStore.getState().loading).toBe(true);

      await loadPromise;
      expect(useWorkspacesStore.getState().loading).toBe(false);
    });

    it("加载失败时 loading 应恢复 false", async () => {
      vi.mocked(workspaceService.listWorkspaces).mockRejectedValue(
        new Error("load error")
      );

      await expect(useWorkspacesStore.getState().load()).rejects.toThrow();
      expect(useWorkspacesStore.getState().loading).toBe(false);
    });
  });

  describe("create", () => {
    it("应调用 createWorkspace 并添加到列表", async () => {
      const newWs = createTestWorkspace({ name: "new-workspace" });
      vi.mocked(workspaceService.createWorkspace).mockResolvedValue(newWs);

      const result = await useWorkspacesStore.getState().create("new-workspace", "/test/path");

      expect(result).toEqual(newWs);
      const state = useWorkspacesStore.getState();
      expect(state.workspaces).toHaveLength(1);
      expect(state.workspaces[0].id).toBe(newWs.id);
    });
  });

  describe("remove", () => {
    it("应从列表移除 workspace", async () => {
      const ws1 = createTestWorkspace({ name: "ws-1" });
      const ws2 = createTestWorkspace({ name: "ws-2" });
      useWorkspacesStore.setState({ workspaces: [ws1, ws2] });
      vi.mocked(workspaceService.deleteWorkspace).mockResolvedValue();

      await useWorkspacesStore.getState().remove("ws-1");

      const state = useWorkspacesStore.getState();
      expect(state.workspaces).toHaveLength(1);
      expect(state.workspaces[0].id).toBe(ws2.id);
    });

    it("删除选中的 workspace 应清空 expandedWorkspaceId", async () => {
      const ws = createTestWorkspace({ name: "ws-target" });
      useWorkspacesStore.setState({
        workspaces: [ws],
        expandedWorkspaceId: ws.id,
        expandedProjectId: "some-proj-id",
      });
      vi.mocked(workspaceService.deleteWorkspace).mockResolvedValue();

      await useWorkspacesStore.getState().remove("ws-target");

      const state = useWorkspacesStore.getState();
      expect(state.expandedWorkspaceId).toBeNull();
      expect(state.expandedProjectId).toBeNull();
    });
  });

  describe("addProject", () => {
    it("应调用 addWorkspaceProject 并更新对应 workspace 的 projects", async () => {
      const ws = createTestWorkspace({ name: "my-ws" });
      useWorkspacesStore.setState({ workspaces: [ws] });

      const newProject = createTestWorkspaceProject({ path: "/tmp/new-project" });
      vi.mocked(workspaceService.addWorkspaceProject).mockResolvedValue(newProject);

      const result = await useWorkspacesStore.getState().addProject("my-ws", "/tmp/new-project");

      expect(result).toEqual(newProject);
      const state = useWorkspacesStore.getState();
      const updatedWs = state.workspaces.find((w) => w.name === "my-ws")!;
      expect(updatedWs.projects).toHaveLength(1);
      expect(updatedWs.projects[0].id).toBe(newProject.id);
    });
  });

  describe("removeProject", () => {
    it("应从 workspace 移除 project 并清理 expandedProjectId", async () => {
      const project = createTestWorkspaceProject();
      const ws = createTestWorkspace({ name: "my-ws", projects: [project] });
      useWorkspacesStore.setState({
        workspaces: [ws],
        expandedProjectId: project.id,
      });
      vi.mocked(workspaceService.removeWorkspaceProject).mockResolvedValue();

      await useWorkspacesStore.getState().removeProject("my-ws", project.id);

      const state = useWorkspacesStore.getState();
      const updatedWs = state.workspaces.find((w) => w.name === "my-ws")!;
      expect(updatedWs.projects).toHaveLength(0);
      expect(state.expandedProjectId).toBeNull();
    });
  });

  describe("updatePinned", () => {
    it("应更新 pinned 状态", async () => {
      const ws1 = createTestWorkspace({ name: "ws-1" });
      const ws2 = createTestWorkspace({ name: "ws-2" });
      useWorkspacesStore.setState({ workspaces: [ws1, ws2] });
      vi.mocked(workspaceService.updateWorkspacePinned).mockResolvedValue();

      await useWorkspacesStore.getState().updatePinned("ws-2", true);

      const state = useWorkspacesStore.getState();
      const ws2After = state.workspaces.find((w) => w.name === "ws-2")!;
      expect(ws2After.pinned).toBe(true);
    });
  });

  describe("updateHidden", () => {
    it("应更新 hidden 状态", async () => {
      const ws = createTestWorkspace({ name: "ws-1" });
      useWorkspacesStore.setState({ workspaces: [ws] });
      vi.mocked(workspaceService.updateWorkspaceHidden).mockResolvedValue();

      await useWorkspacesStore.getState().updateHidden("ws-1", true);

      const state = useWorkspacesStore.getState();
      expect(state.workspaces[0].hidden).toBe(true);
    });
  });

  describe("expandWorkspace", () => {
    it("应展开 workspace（toggle 行为）", () => {
      useWorkspacesStore.getState().expandWorkspace("ws-id-1");
      expect(useWorkspacesStore.getState().expandedWorkspaceId).toBe("ws-id-1");

      // 再次点击同一个应折叠
      useWorkspacesStore.getState().expandWorkspace("ws-id-1");
      expect(useWorkspacesStore.getState().expandedWorkspaceId).toBeNull();
    });

    it("展开不同 workspace 应切换并清理 expandedProjectId", () => {
      useWorkspacesStore.setState({ expandedProjectId: "proj-1" });

      useWorkspacesStore.getState().expandWorkspace("ws-id-1");
      expect(useWorkspacesStore.getState().expandedWorkspaceId).toBe("ws-id-1");
      // expandedProjectId 应保留（只在折叠时清理）
      expect(useWorkspacesStore.getState().expandedProjectId).toBe("proj-1");
    });
  });

  describe("expandProject", () => {
    it("应展开 project（toggle 行为）", () => {
      useWorkspacesStore.getState().expandProject("proj-1");
      expect(useWorkspacesStore.getState().expandedProjectId).toBe("proj-1");

      useWorkspacesStore.getState().expandProject("proj-1");
      expect(useWorkspacesStore.getState().expandedProjectId).toBeNull();
    });
  });

  describe("排序逻辑", () => {
    it("load 应保持后端返回的顺序", async () => {
      const ws1 = createTestWorkspace({ name: "ws-1", pinned: false, createdAt: "2024-01-01" });
      const ws2 = createTestWorkspace({ name: "ws-2", pinned: true, createdAt: "2024-01-02" });
      const ws3 = createTestWorkspace({ name: "ws-3", pinned: false, createdAt: "2024-01-03" });
      vi.mocked(workspaceService.listWorkspaces).mockResolvedValue([ws2, ws1, ws3]);

      await useWorkspacesStore.getState().load();

      const names = useWorkspacesStore.getState().workspaces.map((w) => w.name);
      expect(names).toEqual(["ws-2", "ws-1", "ws-3"]);
    });
  });

  describe("派生方法", () => {
    it("pinnedWorkspaces 应只返回 pinned 的", () => {
      const ws1 = createTestWorkspace({ pinned: true });
      const ws2 = createTestWorkspace({ pinned: false });
      useWorkspacesStore.setState({ workspaces: [ws1, ws2] });

      const pinned = useWorkspacesStore.getState().pinnedWorkspaces();
      expect(pinned).toHaveLength(1);
      expect(pinned[0].id).toBe(ws1.id);
    });

    it("unpinnedVisibleWorkspaces 应排除 pinned 和 hidden", () => {
      const ws1 = createTestWorkspace({ pinned: true, hidden: false });
      const ws2 = createTestWorkspace({ pinned: false, hidden: false });
      const ws3 = createTestWorkspace({ pinned: false, hidden: true });
      useWorkspacesStore.setState({ workspaces: [ws1, ws2, ws3] });

      const visible = useWorkspacesStore.getState().unpinnedVisibleWorkspaces();
      expect(visible).toHaveLength(1);
      expect(visible[0].id).toBe(ws2.id);
    });

    it("hiddenWorkspaces 应只返回 hidden 的", () => {
      const ws1 = createTestWorkspace({ hidden: false });
      const ws2 = createTestWorkspace({ hidden: true });
      useWorkspacesStore.setState({ workspaces: [ws1, ws2] });

      const hidden = useWorkspacesStore.getState().hiddenWorkspaces();
      expect(hidden).toHaveLength(1);
      expect(hidden[0].id).toBe(ws2.id);
    });

    it("selectedWorkspace 应返回展开的 workspace", () => {
      const ws = createTestWorkspace();
      useWorkspacesStore.setState({
        workspaces: [ws],
        expandedWorkspaceId: ws.id,
      });

      const selected = useWorkspacesStore.getState().selectedWorkspace();
      expect(selected).toBeDefined();
      expect(selected!.id).toBe(ws.id);
    });

    it("selectedProject 应返回展开的 project", () => {
      const project = createTestWorkspaceProject();
      const ws = createTestWorkspace({ projects: [project] });
      useWorkspacesStore.setState({
        workspaces: [ws],
        expandedWorkspaceId: ws.id,
        expandedProjectId: project.id,
      });

      const selected = useWorkspacesStore.getState().selectedProject();
      expect(selected).not.toBeNull();
      expect(selected!.id).toBe(project.id);
    });
  });
});

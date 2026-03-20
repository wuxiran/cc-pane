import { describe, it, expect, beforeEach } from "vitest";
import { useProjectsStore } from "./useProjectsStore";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";
import {
  createTestProject,
  createTestProjects,
  resetTestDataCounter,
} from "@/test/utils/testData";

describe("useProjectsStore", () => {
  beforeEach(() => {
    resetTauriInvoke();
    resetTestDataCounter();
    // 重置 store 状态
    useProjectsStore.setState({
      projects: [],
      selectedId: null,
      loading: false,
      error: null,
    });
  });

  describe("初始状态", () => {
    it("应该有正确的初始值", () => {
      const state = useProjectsStore.getState();

      expect(state.projects).toEqual([]);
      expect(state.selectedId).toBeNull();
      expect(state.loading).toBe(false);
      expect(state.error).toBeNull();
    });
  });

  describe("load", () => {
    it("应该加载项目列表并自动选中第一个", async () => {
      const projects = createTestProjects(3);
      mockTauriInvoke({ list_projects: projects });

      await useProjectsStore.getState().load();

      const state = useProjectsStore.getState();
      expect(state.projects).toEqual(projects);
      expect(state.selectedId).toBe(projects[0].id);
      expect(state.loading).toBe(false);
      expect(state.error).toBeNull();
    });

    it("应该在加载期间设置 loading 为 true", async () => {
      mockTauriInvoke({
        list_projects: () =>
          new Promise((resolve) => setTimeout(() => resolve([]), 10)),
      });

      const loadPromise = useProjectsStore.getState().load();

      expect(useProjectsStore.getState().loading).toBe(true);

      await loadPromise;

      expect(useProjectsStore.getState().loading).toBe(false);
    });

    it("应该在加载空列表时不设置 selectedId", async () => {
      mockTauriInvoke({ list_projects: [] });

      await useProjectsStore.getState().load();

      expect(useProjectsStore.getState().selectedId).toBeNull();
    });

    it("应该在已有选中项时保持选中", async () => {
      const projects = createTestProjects(3);
      useProjectsStore.setState({ selectedId: projects[1].id });
      mockTauriInvoke({ list_projects: projects });

      await useProjectsStore.getState().load();

      expect(useProjectsStore.getState().selectedId).toBe(projects[1].id);
    });

    it("应该在加载失败时设置 error", async () => {
      mockTauriInvoke({
        list_projects: () => {
          throw new Error("加载失败");
        },
      });

      await expect(useProjectsStore.getState().load()).rejects.toThrow();

      const state = useProjectsStore.getState();
      expect(state.error).toBeTruthy();
      expect(state.loading).toBe(false);
    });
  });

  describe("add", () => {
    it("应该添加项目并选中", async () => {
      const newProject = createTestProject();
      mockTauriInvoke({
        add_project: newProject,
        init_project_history: undefined,
      });

      const result = await useProjectsStore.getState().add(newProject.path);

      const state = useProjectsStore.getState();
      expect(state.projects).toHaveLength(1);
      expect(state.projects[0]).toEqual(newProject);
      expect(state.selectedId).toBe(newProject.id);
      expect(result).toEqual(newProject);
    });
  });

  describe("remove", () => {
    it("应该删除项目并更新选中", async () => {
      const projects = createTestProjects(2);
      useProjectsStore.setState({
        projects,
        selectedId: projects[0].id,
      });
      mockTauriInvoke({
        remove_project: undefined,
        stop_project_history: undefined,
      });

      await useProjectsStore.getState().remove(projects[0].id);

      const state = useProjectsStore.getState();
      expect(state.projects).toHaveLength(1);
      expect(state.selectedId).toBe(projects[1].id);
    });

    it("应该在删除最后一个项目时将 selectedId 设为 null", async () => {
      const project = createTestProject();
      useProjectsStore.setState({
        projects: [project],
        selectedId: project.id,
      });
      mockTauriInvoke({
        remove_project: undefined,
        stop_project_history: undefined,
      });

      await useProjectsStore.getState().remove(project.id);

      expect(useProjectsStore.getState().selectedId).toBeNull();
    });
  });

  describe("select", () => {
    it("应该更新 selectedId", () => {
      useProjectsStore.getState().select("test-id");

      expect(useProjectsStore.getState().selectedId).toBe("test-id");
    });
  });

  describe("updateName", () => {
    it("应该更新项目名称", async () => {
      const project = createTestProject();
      useProjectsStore.setState({ projects: [project] });
      mockTauriInvoke({
        update_project_name: undefined,
      });

      await useProjectsStore.getState().updateName(project.id, "新名称");

      const updated = useProjectsStore.getState().projects[0];
      expect(updated.name).toBe("新名称");
    });
  });

  describe("selectedProject", () => {
    it("应该返回当前选中的项目", () => {
      const projects = createTestProjects(2);
      useProjectsStore.setState({
        projects,
        selectedId: projects[1].id,
      });

      const selected = useProjectsStore.getState().selectedProject();

      expect(selected).toEqual(projects[1]);
    });

    it("应该在没有选中时返回 undefined", () => {
      const selected = useProjectsStore.getState().selectedProject();

      expect(selected).toBeUndefined();
    });
  });
});

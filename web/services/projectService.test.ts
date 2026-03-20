import { describe, it, expect, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { projectService } from "./projectService";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";
import {
  createTestProject,
  resetTestDataCounter,
} from "@/test/utils/testData";

describe("projectService", () => {
  beforeEach(() => {
    resetTauriInvoke();
    resetTestDataCounter();
  });

  describe("list", () => {
    it("应该调用 list_projects 命令并返回项目列表", async () => {
      const projects = [createTestProject(), createTestProject()];
      mockTauriInvoke({ list_projects: projects });

      const result = await projectService.list();

      expect(invoke).toHaveBeenCalledWith("list_projects");
      expect(result).toEqual(projects);
    });

    it("应该在空列表时返回空数组", async () => {
      mockTauriInvoke({ list_projects: [] });

      const result = await projectService.list();

      expect(result).toEqual([]);
    });
  });

  describe("add", () => {
    it("应该调用 add_project 和 init_project_history", async () => {
      const project = createTestProject({ path: "/tmp/new-project" });
      mockTauriInvoke({
        add_project: project,
        init_project_history: undefined,
      });

      const result = await projectService.add("/tmp/new-project");

      expect(invoke).toHaveBeenCalledWith("add_project", {
        path: "/tmp/new-project",
      });
      expect(invoke).toHaveBeenCalledWith("init_project_history", {
        projectPath: "/tmp/new-project",
      });
      expect(result).toEqual(project);
    });

    it("应该在 init_project_history 失败时仍然返回项目", async () => {
      const project = createTestProject();
      mockTauriInvoke({
        add_project: project,
        init_project_history: () => {
          throw new Error("init failed");
        },
      });

      const result = await projectService.add(project.path);

      expect(result).toEqual(project);
    });
  });

  describe("remove", () => {
    it("应该调用 remove_project 命令", async () => {
      mockTauriInvoke({ remove_project: undefined });

      await projectService.remove("test-id");

      expect(invoke).toHaveBeenCalledWith("remove_project", { id: "test-id" });
    });
  });

  describe("get", () => {
    it("应该返回指定 ID 的项目", async () => {
      const project = createTestProject();
      mockTauriInvoke({ get_project: project });

      const result = await projectService.get(project.id);

      expect(invoke).toHaveBeenCalledWith("get_project", { id: project.id });
      expect(result).toEqual(project);
    });

    it("应该在项目不存在时返回 null", async () => {
      mockTauriInvoke({ get_project: null });

      const result = await projectService.get("non-existent");

      expect(result).toBeNull();
    });
  });

  describe("updateName", () => {
    it("应该调用 update_project_name 命令", async () => {
      mockTauriInvoke({ update_project_name: undefined });

      await projectService.updateName("test-id", "new-name");

      expect(invoke).toHaveBeenCalledWith("update_project_name", {
        id: "test-id",
        name: "new-name",
      });
    });
  });

  describe("updateAlias", () => {
    it("应该调用 update_project_alias 命令", async () => {
      mockTauriInvoke({ update_project_alias: undefined });

      await projectService.updateAlias("test-id", "alias");

      expect(invoke).toHaveBeenCalledWith("update_project_alias", {
        id: "test-id",
        alias: "alias",
      });
    });

    it("应该支持设置 null 别名", async () => {
      mockTauriInvoke({ update_project_alias: undefined });

      await projectService.updateAlias("test-id", null);

      expect(invoke).toHaveBeenCalledWith("update_project_alias", {
        id: "test-id",
        alias: null,
      });
    });
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { historyService } from "./historyService";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";

describe("historyService", () => {
  beforeEach(() => {
    resetTauriInvoke();
  });

  describe("add", () => {
    it("应该调用 add_launch_history 命令并传递正确参数", async () => {
      mockTauriInvoke({ add_launch_history: undefined });

      await historyService.add("proj-1", "My Project", "/path/to/project");

      expect(invoke).toHaveBeenCalledWith("add_launch_history", {
        projectId: "proj-1",
        projectName: "My Project",
        projectPath: "/path/to/project",
        workspaceName: null,
        workspacePath: null,
        launchCwd: null,
      });
    });
  });

  describe("list", () => {
    it("应该调用 list_launch_history 命令并使用默认 limit=20", async () => {
      const records = [
        {
          id: 1,
          projectId: "proj-1",
          projectName: "Project 1",
          projectPath: "/path/1",
          launchedAt: "2024-01-01T00:00:00Z",
        },
      ];
      mockTauriInvoke({ list_launch_history: records });

      const result = await historyService.list();

      expect(invoke).toHaveBeenCalledWith("list_launch_history", { limit: 20 });
      expect(result).toEqual(records);
    });

    it("应该支持自定义 limit 参数", async () => {
      mockTauriInvoke({ list_launch_history: [] });

      const result = await historyService.list(50);

      expect(invoke).toHaveBeenCalledWith("list_launch_history", { limit: 50 });
      expect(result).toEqual([]);
    });

    it("应该在空列表时返回空数组", async () => {
      mockTauriInvoke({ list_launch_history: [] });

      const result = await historyService.list();

      expect(result).toEqual([]);
    });
  });

  describe("clear", () => {
    it("应该调用 clear_launch_history 命令", async () => {
      mockTauriInvoke({ clear_launch_history: undefined });

      await historyService.clear();

      expect(invoke).toHaveBeenCalledWith("clear_launch_history");
    });
  });
});

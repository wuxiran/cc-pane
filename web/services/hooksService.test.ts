import { describe, it, expect, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { hooksService } from "./hooksService";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";

describe("hooksService", () => {
  beforeEach(() => {
    resetTauriInvoke();
  });

  describe("isEnabled", () => {
    it("应该调用 is_hooks_enabled 命令并返回 true", async () => {
      mockTauriInvoke({ is_hooks_enabled: true });

      const result = await hooksService.isEnabled("/path/to/project");

      expect(invoke).toHaveBeenCalledWith("is_hooks_enabled", {
        projectPath: "/path/to/project",
      });
      expect(result).toBe(true);
    });

    it("应该在 hooks 未启用时返回 false", async () => {
      mockTauriInvoke({ is_hooks_enabled: false });

      const result = await hooksService.isEnabled("/path/to/project");

      expect(result).toBe(false);
    });
  });

  describe("enable", () => {
    it("应该调用 enable_hooks 命令", async () => {
      mockTauriInvoke({ enable_hooks: undefined });

      await hooksService.enable("/path/to/project");

      expect(invoke).toHaveBeenCalledWith("enable_hooks", {
        projectPath: "/path/to/project",
      });
    });
  });

  describe("disable", () => {
    it("应该调用 disable_hooks 命令", async () => {
      mockTauriInvoke({ disable_hooks: undefined });

      await hooksService.disable("/path/to/project");

      expect(invoke).toHaveBeenCalledWith("disable_hooks", {
        projectPath: "/path/to/project",
      });
    });
  });

  describe("getWorkflow", () => {
    it("应该调用 get_workflow 命令并返回 workflow 内容", async () => {
      const workflowContent = "# Workflow\n\n## Steps\n1. Build\n2. Test";
      mockTauriInvoke({ get_workflow: workflowContent });

      const result = await hooksService.getWorkflow("/path/to/project");

      expect(invoke).toHaveBeenCalledWith("get_workflow", {
        projectPath: "/path/to/project",
      });
      expect(result).toBe(workflowContent);
    });

    it("应该在 workflow 为空时返回空字符串", async () => {
      mockTauriInvoke({ get_workflow: "" });

      const result = await hooksService.getWorkflow("/path/to/project");

      expect(result).toBe("");
    });
  });

  describe("saveWorkflow", () => {
    it("应该调用 save_workflow 命令并传递内容", async () => {
      mockTauriInvoke({ save_workflow: undefined });

      await hooksService.saveWorkflow("/path/to/project", "# New Workflow");

      expect(invoke).toHaveBeenCalledWith("save_workflow", {
        projectPath: "/path/to/project",
        content: "# New Workflow",
      });
    });
  });

  describe("initCcpanes", () => {
    it("应该调用 init_ccpanes 命令", async () => {
      mockTauriInvoke({ init_ccpanes: undefined });

      await hooksService.initCcpanes("/path/to/project");

      expect(invoke).toHaveBeenCalledWith("init_ccpanes", {
        projectPath: "/path/to/project",
      });
    });
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { projectCliHooksService } from "./projectCliHooksService";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";

describe("projectCliHooksService", () => {
  beforeEach(() => {
    resetTauriInvoke();
  });

  it("calls get_project_cli_hooks", async () => {
    const payload = [
      {
        cliTool: "claude",
        label: "Claude Code",
        supported: true,
        reason: null,
        hooks: [],
      },
    ];
    mockTauriInvoke({ get_project_cli_hooks: payload });

    const result = await projectCliHooksService.getStatus("/path/to/project");

    expect(invoke).toHaveBeenCalledWith("get_project_cli_hooks", {
      projectPath: "/path/to/project",
    });
    expect(result).toEqual(payload);
  });

  it("calls set_project_cli_hook_enabled", async () => {
    mockTauriInvoke({ set_project_cli_hook_enabled: undefined });

    await projectCliHooksService.setHookEnabled(
      "/path/to/project",
      "claude",
      "session-inject",
      true,
    );

    expect(invoke).toHaveBeenCalledWith("set_project_cli_hook_enabled", {
      projectPath: "/path/to/project",
      cliTool: "claude",
      hookName: "session-inject",
      enabled: true,
    });
  });
});

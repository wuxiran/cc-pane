import { describe, it, expect, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  executeWorkspaceMigration,
  previewWorkspaceMigration,
  rollbackWorkspaceMigration,
} from "./workspaceService";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";
import {
  createTestWorkspace,
  resetTestDataCounter,
} from "@/test/utils/testData";

describe("workspace migration service", () => {
  beforeEach(() => {
    resetTauriInvoke();
    resetTestDataCounter();
  });

  it("调用 preview_workspace_migration 命令", async () => {
    const plan = {
      workspaceName: "ws-1",
      sourceRoot: "D:/workspace",
      rootDestination: "/home/dev/workspace",
      targetKind: "wsl" as const,
      targetRoot: "/home/dev/workspace",
      targetDistro: "Ubuntu",
      items: [],
      warnings: [],
    };
    mockTauriInvoke({ preview_workspace_migration: plan });

    const result = await previewWorkspaceMigration({
      workspaceName: "ws-1",
      targetKind: "wsl",
      targetRoot: "/home/dev/workspace",
      targetDistro: "Ubuntu",
    });

    expect(invoke).toHaveBeenCalledWith("preview_workspace_migration", {
      request: {
        workspaceName: "ws-1",
        targetKind: "wsl",
        targetRoot: "/home/dev/workspace",
        targetDistro: "Ubuntu",
      },
    });
    expect(result).toEqual(plan);
  });

  it("调用 execute_workspace_migration 命令", async () => {
    const workspace = createTestWorkspace({
      name: "ws-1",
      defaultEnvironment: "wsl",
      wsl: {
        distro: "Ubuntu",
        remotePath: "/home/dev/workspace",
      },
    });
    const migrationResult = {
      status: "succeeded" as const,
      snapshotId: "snapshot-1",
      workspace,
      plan: {
        workspaceName: "ws-1",
        sourceRoot: "D:/workspace",
        rootDestination: "/home/dev/workspace",
        targetKind: "wsl" as const,
        targetRoot: "/home/dev/workspace",
        targetDistro: "Ubuntu",
        items: [],
        warnings: [],
      },
      copiedFiles: 12,
      copiedBytes: 4096,
      warnings: [],
    };
    mockTauriInvoke({ execute_workspace_migration: migrationResult });

    const result = await executeWorkspaceMigration({
      workspaceName: "ws-1",
      targetKind: "wsl",
      targetRoot: "/home/dev/workspace",
      targetDistro: "Ubuntu",
    });

    expect(invoke).toHaveBeenCalledWith("execute_workspace_migration", {
      request: {
        workspaceName: "ws-1",
        targetKind: "wsl",
        targetRoot: "/home/dev/workspace",
        targetDistro: "Ubuntu",
      },
    });
    expect(result).toEqual(migrationResult);
  });

  it("调用 rollback_workspace_migration 命令", async () => {
    const workspace = createTestWorkspace({ name: "ws-1" });
    const rollbackResult = {
      snapshotId: "snapshot-1",
      workspace,
    };
    mockTauriInvoke({ rollback_workspace_migration: rollbackResult });

    const result = await rollbackWorkspaceMigration("ws-1", "snapshot-1");

    expect(invoke).toHaveBeenCalledWith("rollback_workspace_migration", {
      workspaceName: "ws-1",
      snapshotId: "snapshot-1",
    });
    expect(result).toEqual(rollbackResult);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import type { LaunchRecord } from "@/services";
import {
  createTestWorkspace,
  createTestWorkspaceProject,
} from "@/test/utils/testData";
import { buildLaunchRecordTerminalOptions } from "./launchHistory";

function createRecord(overrides?: Partial<LaunchRecord>): LaunchRecord {
  return {
    id: 1,
    projectId: "project-1",
    projectName: "project-1",
    projectPath: "D:/workspace-root/apps/api",
    launchedAt: "2026-04-19T00:00:00Z",
    workspaceName: "workspace-1",
    workspacePath: "D:/workspace-root",
    launchCwd: "D:/workspace-root",
    providerId: "provider-1",
    cliTool: "codex",
    runtimeKind: "local",
    resumeSessionId: "resume-1",
    ...overrides,
  };
}

describe("launchHistory", () => {
  const originalPlatform = window.navigator.platform;

  afterEach(() => {
    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  it("falls back to the recorded launch metadata for local sessions", () => {
    const record = createRecord({ runtimeKind: "local", providerSelection: "none" });

    const options = buildLaunchRecordTerminalOptions(record, [], []);

    expect(options).toMatchObject({
      path: record.projectPath,
      workspaceName: record.workspaceName,
      workspacePath: record.launchCwd,
      cliTool: "codex",
      providerSelection: "none",
      resumeId: "resume-1",
    });
  });

  it("reconstructs WSL launch options from the current workspace config", () => {
    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: "Win32",
    });
    const workspace = createTestWorkspace({
      name: "workspace-1",
      path: "D:/workspace-root",
      defaultEnvironment: "wsl",
      wsl: {
        distro: "Ubuntu",
        remotePath: "/mnt/d/workspace-root",
      },
      projects: [
        createTestWorkspaceProject({
          path: "D:/workspace-root/apps/api",
        }),
      ],
    });
    const record = createRecord({ runtimeKind: "wsl" });

    const options = buildLaunchRecordTerminalOptions(record, [workspace], []);

    expect(options).toMatchObject({
      path: "D:/workspace-root/apps/api",
      cliTool: "codex",
      resumeId: "resume-1",
      wsl: {
        distro: "Ubuntu",
        remotePath: "/mnt/d/workspace-root/apps/api",
      },
    });
  });
});

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

  it("omits null provider metadata from old launch records", () => {
    const record = createRecord({
      providerId: null,
      providerSelection: null,
      workspaceName: null,
      launchCwd: null,
      workspacePath: null,
    } as unknown as Partial<LaunchRecord>);

    const options = buildLaunchRecordTerminalOptions(record, [], []);

    expect(options).toEqual({
      path: record.projectPath,
      cliTool: "codex",
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

describe("launchHistory · verbatim 路径污染兜底", () => {
  // 存量历史记录仍带被 CLI hook 回填的 `\\?\` 路径，从「最近启动」再启动时
  // 它会成为 OpenTerminalOptions.workspacePath 并被 cmd.exe 拒绝。
  // 见 docs/35-unc-path-contamination.md。
  it("launchCwd 带 verbatim 前缀时 workspacePath 解析后是干净的", () => {
    const record = createRecord({
      runtimeKind: "local",
      launchCwd: String.raw`\\?\C:\Users\me\.cc-panes-dev\workspaces\default`,
      workspacePath: String.raw`C:\Users\me\.cc-panes-dev\workspaces\default`,
    });

    const options = buildLaunchRecordTerminalOptions(record, [], []);

    expect(options.workspacePath).toBe(
      String.raw`C:\Users\me\.cc-panes-dev\workspaces\default`,
    );
  });

  it("launchCwd 缺失时回落的 workspacePath 同样被兜底", () => {
    const record = createRecord({
      runtimeKind: "local",
      launchCwd: undefined,
      workspacePath: String.raw`\\?\C:\ws`,
    });

    expect(buildLaunchRecordTerminalOptions(record, [], []).workspacePath).toBe(
      String.raw`C:\ws`,
    );
  });

  it("干净路径不被改写", () => {
    const record = createRecord({ runtimeKind: "local", launchCwd: "D:/workspace-root" });

    expect(buildLaunchRecordTerminalOptions(record, [], []).workspacePath).toBe("D:/workspace-root");
  });
});

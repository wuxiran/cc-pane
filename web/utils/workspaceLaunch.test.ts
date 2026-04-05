import { describe, expect, it } from "vitest";
import type { SshMachine, Workspace } from "@/types";
import {
  createTestWorkspace,
  createTestWorkspaceProject,
} from "@/test/utils/testData";
import {
  getWorkspaceEnvironmentIssue,
  getWorkspaceProjectKind,
  resolveWorkspaceLaunchOptions,
  resolveWorkspaceProjectWslPath,
} from "./workspaceLaunch";

function createMachine(overrides?: Partial<SshMachine>): SshMachine {
  return {
    id: "machine-1",
    name: "Devbox",
    host: "devbox.local",
    port: 22,
    user: "dev",
    authMethod: "key",
    identityFile: "~/.ssh/id_ed25519",
    defaultPath: "/home/dev",
    tags: [],
    createdAt: "2026-04-02T00:00:00Z",
    updatedAt: "2026-04-02T00:00:00Z",
    ...overrides,
  };
}

describe("workspaceLaunch", () => {
  it("returns local_path_missing when no local anchor or project exists", () => {
    const workspace = createTestWorkspace({ path: undefined });

    const issue = getWorkspaceEnvironmentIssue({
      workspace,
      environment: "local",
      machines: [],
      platform: "windows",
    });

    expect(issue?.code).toBe("local_path_missing");
  });

  it("falls back to first local project when workspace path is missing", () => {
    const workspace = createTestWorkspace({
      path: undefined,
      projects: [
        createTestWorkspaceProject({ path: "D:/repo/app" }),
      ],
    });

    const { options, issue } = resolveWorkspaceLaunchOptions({
      workspace,
      environment: "local",
      machines: [],
      platform: "windows",
    });

    expect(issue).toBeNull();
    expect(options).toMatchObject({
      path: "D:/repo/app",
      workspaceName: workspace.name,
    });
  });

  it("returns wsl_unsupported on non-Windows", () => {
    const workspace = createTestWorkspace({
      path: "/tmp/project",
      wsl: { remotePath: "/mnt/d/project" },
    });

    const issue = getWorkspaceEnvironmentIssue({
      workspace,
      environment: "wsl",
      machines: [],
      platform: "macos",
    });

    expect(issue?.code).toBe("wsl_unsupported");
  });

  it("derives workspace WSL path from workspace.path when remote root is blank", () => {
    const workspace = createTestWorkspace({
      path: "D:/workspace-root",
      defaultEnvironment: "wsl",
    });

    const { options, issue } = resolveWorkspaceLaunchOptions({
      workspace,
      machines: [],
      platform: "windows",
    });

    expect(issue).toBeNull();
    expect(options?.wsl?.remotePath).toBe("/mnt/d/workspace-root");
    expect(options?.path).toBe("D:/workspace-root");
  });

  it("keeps Codex on local launch when workspace default environment is local", () => {
    const workspace = createTestWorkspace({
      path: "D:/workspace-root",
      providerId: "provider-1",
      defaultEnvironment: "local",
    });

    const { options, issue } = resolveWorkspaceLaunchOptions({
      workspace,
      cliTool: "codex",
      machines: [],
      platform: "windows",
    });

    expect(issue).toBeNull();
    expect(options).toMatchObject({
      path: "D:/workspace-root",
      cliTool: "codex",
    });
    expect(options?.wsl).toBeUndefined();
    expect(options?.providerId).toBeUndefined();
  });

  it("launches Codex through WSL when workspace default environment is wsl", () => {
    const workspace = createTestWorkspace({
      path: "\\\\wsl.localhost\\Ubuntu\\home\\dev\\workspace-root",
      defaultEnvironment: "wsl",
    });

    const { options, issue } = resolveWorkspaceLaunchOptions({
      workspace,
      cliTool: "codex",
      machines: [],
      platform: "windows",
    });

    expect(issue).toBeNull();
    expect(options).toMatchObject({
      path: "\\\\wsl.localhost\\Ubuntu\\home\\dev\\workspace-root",
      cliTool: "codex",
      wsl: {
        remotePath: "/home/dev/workspace-root",
      },
    });
  });

  it("falls back to first project WSL path when workspace path is missing", () => {
    const workspace = createTestWorkspace({
      path: undefined,
      defaultEnvironment: "wsl",
      projects: [
        createTestWorkspaceProject({
          path: "\\\\wsl$\\Ubuntu\\home\\dev\\repo",
          wslRemotePath: "/home/dev/repo",
        }),
      ],
    });

    const { options, issue } = resolveWorkspaceLaunchOptions({
      workspace,
      machines: [],
      platform: "windows",
    });

    expect(issue).toBeNull();
    expect(options).toMatchObject({
      path: "\\\\wsl$\\Ubuntu\\home\\dev\\repo",
      wsl: {
        remotePath: "/home/dev/repo",
      },
    });
  });

  it("resolves workspace SSH config into launch options", () => {
    const workspace: Workspace = createTestWorkspace({
      name: "workspace-ssh",
      path: "D:/workspace-ssh",
      defaultEnvironment: "ssh",
      sshLaunch: {
        machineId: "machine-1",
        remotePath: "/home/dev/workspace-ssh",
      },
    });
    const machine = createMachine();

    const { options, issue } = resolveWorkspaceLaunchOptions({
      workspace,
      machines: [machine],
      cliTool: "codex",
      providerId: "provider-1",
      platform: "windows",
    });

    expect(issue).toBeNull();
    expect(options).toMatchObject({
      path: "ssh://dev@devbox.local/home/dev/workspace-ssh",
      workspaceName: "workspace-ssh",
      cliTool: "codex",
      machineName: "Devbox",
      ssh: {
        host: "devbox.local",
        port: 22,
        user: "dev",
        remotePath: "/home/dev/workspace-ssh",
        identityFile: "~/.ssh/id_ed25519",
      },
    });
    expect(options?.providerId).toBeUndefined();
  });

  it("falls back to first SSH project when workspace SSH config is absent", () => {
    const workspace = createTestWorkspace({
      defaultEnvironment: "ssh",
      projects: [
        createTestWorkspaceProject({
          path: "ssh://dev@devbox.local/home/dev/fallback",
          ssh: {
            host: "devbox.local",
            port: 22,
            user: "dev",
            remotePath: "/home/dev/fallback",
            identityFile: "~/.ssh/id_ed25519",
          },
        }),
      ],
    });
    const machine = createMachine();

    const { options, issue } = resolveWorkspaceLaunchOptions({
      workspace,
      machines: [machine],
      platform: "windows",
    });

    expect(issue).toBeNull();
    expect(options).toMatchObject({
      path: "ssh://dev@devbox.local/home/dev/fallback",
      machineName: "Devbox",
      ssh: {
        host: "devbox.local",
        remotePath: "/home/dev/fallback",
      },
    });
  });

  it("prefers migrated project WSL path", () => {
    const workspace = createTestWorkspace({
      path: "D:/workspace-root",
      wsl: { remotePath: "/home/dev/workspace-root" },
    });
    const project = createTestWorkspaceProject({
      path: "D:/workspace-root/apps/api",
      wslRemotePath: "/home/dev/workspace-root/apps/api",
    });

    expect(resolveWorkspaceProjectWslPath(workspace, project)).toBe(
      "/home/dev/workspace-root/apps/api",
    );
  });

  it("derives project WSL path from workspace roots", () => {
    const workspace = createTestWorkspace({
      path: "D:/workspace-root",
      wsl: { remotePath: "/home/dev/workspace-root" },
    });
    const project = createTestWorkspaceProject({
      path: "D:/workspace-root/apps/web",
    });

    expect(resolveWorkspaceProjectWslPath(workspace, project)).toBe(
      "/home/dev/workspace-root/apps/web",
    );
  });

  it("falls back to drive mapping for standalone local project", () => {
    const workspace = createTestWorkspace({
      path: "D:/workspace-root",
    });
    const project = createTestWorkspaceProject({
      path: "D:/workspace-root/apps/web",
    });

    expect(resolveWorkspaceProjectWslPath(workspace, project)).toBe(
      "/mnt/d/workspace-root/apps/web",
    );
  });

  it("derives project WSL path from UNC WSL project path without persisted remote path", () => {
    const workspace = createTestWorkspace({
      path: undefined,
    });
    const project = createTestWorkspaceProject({
      path: "\\\\wsl.localhost\\Ubuntu\\home\\dev\\workspace-root\\apps\\web",
    });

    expect(resolveWorkspaceProjectWslPath(workspace, project)).toBe(
      "/home/dev/workspace-root/apps/web",
    );
  });

  it("classifies local, wsl, and ssh projects", () => {
    expect(getWorkspaceProjectKind(createTestWorkspaceProject())).toBe("local");
    expect(getWorkspaceProjectKind(createTestWorkspaceProject({
      path: "\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo",
    }))).toBe("wsl");
    expect(getWorkspaceProjectKind(createTestWorkspaceProject({
      wslRemotePath: "/home/dev/repo",
    }))).toBe("wsl");
    expect(getWorkspaceProjectKind(createTestWorkspaceProject({
      ssh: {
        host: "devbox.local",
        port: 22,
        user: "dev",
        remotePath: "/home/dev/repo",
      },
    }))).toBe("ssh");
  });
});

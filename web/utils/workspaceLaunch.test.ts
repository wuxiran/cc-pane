import { afterEach, describe, expect, it } from "vitest";
import type { LaunchProfile, SshMachine, Workspace } from "@/types";
import { useLaunchProfilesStore } from "@/stores/useLaunchProfilesStore";
import {
  createTestWorkspace,
  createTestWorkspaceProject,
} from "@/test/utils/testData";
import {
  getWorkspaceEnvironmentIssue,
  getWorkspaceProjectKind,
  resolveCliEnvironmentDefault,
  resolveWorkspaceProjectLaunchOptions,
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

function createLaunchProfile(overrides: Partial<LaunchProfile> = {}): LaunchProfile {
  return {
    id: "profile-1",
    name: "Codex Fast",
    alias: null,
    description: null,
    providerId: null,
    targetTools: ["codex"],
    targetRuntime: null,
    mcpPolicy: {
      mode: "default",
      enabledServerIds: [],
      disabledServerIds: [],
      includeCcpanesMcp: true,
      includeSharedMcp: true,
    },
    skillPolicy: {
      mode: "core",
      enabledSkillIds: [],
      disabledSkillIds: [],
      profileSkills: [],
      includeProjectSkills: true,
      includeExternalClaudeSkills: true,
      includeExternalCodexSkills: true,
      includeExternalPluginSkills: true,
      target: "session",
    },
    isDefault: false,
    createdAt: "2026-05-03T00:00:00Z",
    updatedAt: "2026-05-03T00:00:00Z",
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
      projects: [createTestWorkspaceProject({ path: "D:/repo/app" })],
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
    expect(options?.launchProfileId).toBeUndefined();
  });

  it("does not inherit the workspace provider for Claude by default", () => {
    const workspace = createTestWorkspace({
      path: "D:/workspace-root",
      providerId: "provider-1",
      defaultEnvironment: "local",
    });

    const { options, issue } = resolveWorkspaceLaunchOptions({
      workspace,
      cliTool: "claude",
      machines: [],
      platform: "windows",
    });

    expect(issue).toBeNull();
    expect(options).toMatchObject({
      path: "D:/workspace-root",
      cliTool: "claude",
    });
    expect(options?.providerId).toBeUndefined();
    expect(options?.launchProfileId).toBeUndefined();
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

  it("prefers the Claude CLI default over the workspace default", () => {
    const workspace = createTestWorkspace({
      path: "D:/workspace-root",
      defaultEnvironment: "local",
      cliEnvironmentDefaults: {
        claude: "wsl",
      },
    });

    const { options, issue } = resolveWorkspaceLaunchOptions({
      workspace,
      cliTool: "claude",
      machines: [],
      platform: "windows",
    });

    expect(issue).toBeNull();
    expect(options).toMatchObject({
      path: "D:/workspace-root",
      cliTool: "claude",
      wsl: {
        remotePath: "/mnt/d/workspace-root",
      },
    });
  });

  it("falls back to the workspace default when a CLI default is absent", () => {
    const workspace = createTestWorkspace({
      path: "D:/workspace-root",
      defaultEnvironment: "local",
      cliEnvironmentDefaults: {
        claude: "wsl",
      },
    });

    const { options, issue } = resolveWorkspaceLaunchOptions({
      workspace,
      cliTool: "codex",
      machines: [],
      platform: "windows",
    });

    expect(issue).toBeNull();
    expect(resolveCliEnvironmentDefault(workspace, "codex")).toBeUndefined();
    expect(options).toMatchObject({
      path: "D:/workspace-root",
      cliTool: "codex",
    });
    expect(options?.wsl).toBeUndefined();
  });

  it("ignores CLI defaults for non-Claude/Codex tools", () => {
    const workspace = createTestWorkspace({
      path: "D:/workspace-root",
      defaultEnvironment: "local",
      cliEnvironmentDefaults: {
        claude: "wsl",
        codex: "wsl",
      },
    });

    const { options, issue } = resolveWorkspaceLaunchOptions({
      workspace,
      cliTool: "gemini",
      machines: [],
      platform: "windows",
    });

    expect(issue).toBeNull();
    expect(resolveCliEnvironmentDefault(workspace, "gemini")).toBeUndefined();
    expect(options).toMatchObject({
      path: "D:/workspace-root",
      cliTool: "gemini",
    });
    expect(options?.wsl).toBeUndefined();
  });

  it("lets an explicit environment override a CLI default", () => {
    const workspace = createTestWorkspace({
      path: "D:/workspace-root",
      defaultEnvironment: "local",
      cliEnvironmentDefaults: {
        codex: "wsl",
      },
    });

    const { options, issue } = resolveWorkspaceLaunchOptions({
      workspace,
      cliTool: "codex",
      environment: "local",
      machines: [],
      platform: "windows",
    });

    expect(issue).toBeNull();
    expect(options).toMatchObject({
      path: "D:/workspace-root",
      cliTool: "codex",
    });
    expect(options?.wsl).toBeUndefined();
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
      providerId: "provider-1",
      cliTool: "codex",
      machineName: "Devbox",
      ssh: {
        host: "devbox.local",
        port: 22,
        user: "dev",
        remotePath: "/home/dev/workspace-ssh",
        identityFile: "~/.ssh/id_ed25519",
        machineId: "machine-1",
        authMethod: "key",
      },
    });
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
            machineId: "machine-1",
            authMethod: "key",
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
        machineId: "machine-1",
        authMethod: "key",
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
    expect(
      getWorkspaceProjectKind(
        createTestWorkspaceProject({
          path: "\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo",
        }),
      ),
    ).toBe("wsl");
    expect(
      getWorkspaceProjectKind(
        createTestWorkspaceProject({
          wslRemotePath: "/home/dev/repo",
        }),
      ),
    ).toBe("wsl");
    expect(
      getWorkspaceProjectKind(
        createTestWorkspaceProject({
          ssh: {
            host: "devbox.local",
            port: 22,
            user: "dev",
            remotePath: "/home/dev/repo",
          },
        }),
      ),
    ).toBe("ssh");
  });

  it("resolves project launch through WSL when workspace default environment is wsl", () => {
    const workspace = createTestWorkspace({
      path: "D:/workspace-root",
      defaultEnvironment: "wsl",
      wsl: { distro: "Ubuntu", remotePath: "/mnt/d/workspace-root" },
    });
    const project = createTestWorkspaceProject({
      path: "D:/workspace-root/apps/api",
    });

    const { options, issue } = resolveWorkspaceProjectLaunchOptions({
      workspace,
      project,
      cliTool: "claude",
      machines: [],
      platform: "windows",
    });

    expect(issue).toBeNull();
    expect(options).toMatchObject({
      path: "D:/workspace-root/apps/api",
      cliTool: "claude",
      wsl: {
        distro: "Ubuntu",
        remotePath: "/mnt/d/workspace-root/apps/api",
      },
    });
    expect(options?.providerId).toBeUndefined();
  });

  it("uses the CLI default for project launches after project.ssh is checked", () => {
    const workspace = createTestWorkspace({
      path: "D:/workspace-root",
      defaultEnvironment: "local",
      cliEnvironmentDefaults: {
        claude: "wsl",
      },
      wsl: { distro: "Ubuntu", remotePath: "/mnt/d/workspace-root" },
    });
    const project = createTestWorkspaceProject({
      path: "D:/workspace-root/apps/api",
    });

    const { options, issue } = resolveWorkspaceProjectLaunchOptions({
      workspace,
      project,
      cliTool: "claude",
      machines: [],
      platform: "windows",
    });

    expect(issue).toBeNull();
    expect(options).toMatchObject({
      path: "D:/workspace-root/apps/api",
      cliTool: "claude",
      wsl: {
        distro: "Ubuntu",
        remotePath: "/mnt/d/workspace-root/apps/api",
      },
    });
  });

  it("keeps project SSH launches ahead of a local CLI default", () => {
    const workspace = createTestWorkspace({
      path: "D:/workspace-root",
      defaultEnvironment: "wsl",
      cliEnvironmentDefaults: {
        codex: "local",
      },
    });
    const project = createTestWorkspaceProject({
      path: "ssh://dev@devbox.local/home/dev/repo",
      ssh: {
        host: "devbox.local",
        port: 22,
        user: "dev",
        remotePath: "/home/dev/repo",
        machineId: "machine-1",
        authMethod: "key",
      },
    });
    const machine = createMachine();

    const { options, issue } = resolveWorkspaceProjectLaunchOptions({
      workspace,
      project,
      cliTool: "codex",
      machines: [machine],
      platform: "windows",
    });

    expect(issue).toBeNull();
    expect(options).toMatchObject({
      path: "ssh://dev@devbox.local/home/dev/repo",
      cliTool: "codex",
      ssh: {
        host: "devbox.local",
        remotePath: "/home/dev/repo",
        machineId: "machine-1",
      },
    });
    expect(options?.wsl).toBeUndefined();
  });

  it("returns a WSL issue instead of falling back locally when a project cannot be mapped", () => {
    const workspace = createTestWorkspace({
      path: undefined,
      defaultEnvironment: "wsl",
    });
    const project = createTestWorkspaceProject({
      path: "/tmp/project",
    });

    const { options, issue } = resolveWorkspaceProjectLaunchOptions({
      workspace,
      project,
      cliTool: "claude",
      machines: [],
      platform: "windows",
    });

    expect(options).toBeNull();
    expect(issue?.code).toBe("wsl_local_path_missing");
  });

  it("allows explicit provider selection for project launch in WSL mode", () => {
    const workspace = createTestWorkspace({
      path: "D:/workspace-root",
      defaultEnvironment: "wsl",
      wsl: { remotePath: "/mnt/d/workspace-root" },
    });
    const project = createTestWorkspaceProject({
      path: "D:/workspace-root/apps/api",
    });

    const { options, issue } = resolveWorkspaceProjectLaunchOptions({
      workspace,
      project,
      cliTool: "gemini",
      providerId: "provider-gemini",
      machines: [],
      platform: "windows",
    });

    expect(issue).toBeNull();
    expect(options?.providerId).toBe("provider-gemini");
    expect(options?.wsl?.remotePath).toBe("/mnt/d/workspace-root/apps/api");
  });

  it("passes providerSelection=none through workspace launches", () => {
    const workspace = createTestWorkspace({
      path: "D:/workspace-root",
      providerId: "workspace-provider",
      defaultEnvironment: "local",
    });

    const { options, issue } = resolveWorkspaceLaunchOptions({
      workspace,
      cliTool: "claude",
      providerSelection: "none",
      machines: [],
      platform: "windows",
    });

    expect(issue).toBeNull();
    expect(options?.providerId).toBeUndefined();
    expect(options?.providerSelection).toBe("none");
  });

  it("allows explicit launch profile selection to override workspace binding", () => {
    const workspace = createTestWorkspace({
      path: "D:/workspace-root",
      launchProfileId: "workspace-profile",
      defaultEnvironment: "local",
    });

    const { options, issue } = resolveWorkspaceLaunchOptions({
      workspace,
      cliTool: "codex",
      launchProfileId: "selected-profile",
      machines: [],
      platform: "windows",
    });

    expect(issue).toBeNull();
    expect(options?.launchProfileId).toBe("selected-profile");
  });

  describe("绑定 profile 的 CLI/运行环境过滤", () => {
    afterEach(() => {
      useLaunchProfilesStore.setState({ profiles: [] });
    });

    it("workspace 绑定的 profile 不适用于目标 CLI 时静默丢弃（不触发后端 mismatch 警告）", () => {
      useLaunchProfilesStore.setState({
        profiles: [createLaunchProfile({ id: "codex-only", targetTools: ["codex"] })],
      });
      const workspace = createTestWorkspace({
        path: "D:/workspace-root",
        launchProfileId: "codex-only",
        defaultEnvironment: "local",
      });

      const { options, issue } = resolveWorkspaceLaunchOptions({
        workspace,
        cliTool: "claude",
        machines: [],
        platform: "windows",
      });

      expect(issue).toBeNull();
      expect(options?.launchProfileId).toBeUndefined();
    });

    it("workspace 绑定的 profile 适用于目标 CLI 时正常传递", () => {
      useLaunchProfilesStore.setState({
        profiles: [createLaunchProfile({ id: "codex-only", targetTools: ["codex"] })],
      });
      const workspace = createTestWorkspace({
        path: "D:/workspace-root",
        launchProfileId: "codex-only",
        defaultEnvironment: "local",
      });

      const { options } = resolveWorkspaceLaunchOptions({
        workspace,
        cliTool: "codex",
        machines: [],
        platform: "windows",
      });

      expect(options?.launchProfileId).toBe("codex-only");
    });

    it("项目绑定的 profile 运行环境不匹配时静默丢弃", () => {
      useLaunchProfilesStore.setState({
        profiles: [createLaunchProfile({ id: "wsl-only", targetTools: [], targetRuntime: "wsl" })],
      });
      const workspace = createTestWorkspace({
        path: "D:/workspace-root",
        defaultEnvironment: "local",
      });
      const project = createTestWorkspaceProject({
        path: "D:/workspace-root/apps/api",
        launchProfileId: "wsl-only",
      });

      const { options, issue } = resolveWorkspaceProjectLaunchOptions({
        workspace,
        project,
        cliTool: "claude",
        machines: [],
        platform: "windows",
      });

      expect(issue).toBeNull();
      expect(options?.launchProfileId).toBeUndefined();
    });

    it("显式传入的 launchProfileId 不经过滤（保留后端 mismatch 警告）", () => {
      useLaunchProfilesStore.setState({
        profiles: [createLaunchProfile({ id: "codex-only", targetTools: ["codex"] })],
      });
      const workspace = createTestWorkspace({
        path: "D:/workspace-root",
        defaultEnvironment: "local",
      });

      const { options } = resolveWorkspaceLaunchOptions({
        workspace,
        cliTool: "claude",
        launchProfileId: "codex-only",
        machines: [],
        platform: "windows",
      });

      expect(options?.launchProfileId).toBe("codex-only");
    });

    it("绑定 profile 在本地列表中不存在时保持原样传递", () => {
      const workspace = createTestWorkspace({
        path: "D:/workspace-root",
        launchProfileId: "unknown-profile",
        defaultEnvironment: "local",
      });

      const { options } = resolveWorkspaceLaunchOptions({
        workspace,
        cliTool: "claude",
        machines: [],
        platform: "windows",
      });

      expect(options?.launchProfileId).toBe("unknown-profile");
    });
  });
});

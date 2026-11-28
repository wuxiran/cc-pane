import { afterEach, describe, expect, it } from "vitest";
import type { CliTool, LaunchProfile, SshMachine, Workspace } from "@/types";
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
      delivery: "direct",
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
  it.each([
    {
      code: "local_path_missing",
      workspace: { path: undefined },
      environment: "local" as const,
      platform: "windows" as const,
    },
    {
      code: "wsl_unsupported",
      workspace: { path: "/tmp/project", wsl: { remotePath: "/mnt/d/project" } },
      environment: "wsl" as const,
      platform: "macos" as const,
    },
  ])("returns $code from getWorkspaceEnvironmentIssue", ({ code, workspace, environment, platform }) => {
    const issue = getWorkspaceEnvironmentIssue({
      workspace: createTestWorkspace(workspace),
      environment,
      machines: [],
      platform,
    });

    expect(issue?.code).toBe(code);
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

  it("returns path_platform_mismatch for a Windows local path on macOS", () => {
    const workspace = createTestWorkspace({ path: "D:\\repo" });

    const { options, issue } = resolveWorkspaceLaunchOptions({
      workspace,
      environment: "local",
      machines: [],
      platform: "macos",
    });

    expect(options).toBeNull();
    expect(issue).toMatchObject({
      environment: "local",
      code: "path_platform_mismatch",
      detail: "D:\\repo",
    });
  });

  it("does not classify an SSH display path as a local platform mismatch", () => {
    const workspace = createTestWorkspace({
      path: "D:\\repo",
      defaultEnvironment: "ssh",
      sshLaunch: { machineId: "machine-1", remotePath: "/srv/repo" },
    });

    const { options, issue } = resolveWorkspaceLaunchOptions({
      workspace,
      environment: "ssh",
      machines: [createMachine()],
      platform: "macos",
    });

    expect(issue).toBeNull();
    expect(options?.ssh?.remotePath).toBe("/srv/repo");
  });

  it.each([
    {
      label: "drive path",
      path: "D:/workspace-root",
      cliTool: undefined,
      remotePath: "/mnt/d/workspace-root",
    },
    {
      label: "UNC WSL path (Codex)",
      path: "\\\\wsl.localhost\\Ubuntu\\home\\dev\\workspace-root",
      cliTool: "codex" as const,
      remotePath: "/home/dev/workspace-root",
    },
  ])("derives workspace WSL path from workspace.path ($label) when default environment is wsl", ({ path, cliTool, remotePath }) => {
    const workspace = createTestWorkspace({ path, defaultEnvironment: "wsl" });

    const { options, issue } = resolveWorkspaceLaunchOptions({
      workspace,
      cliTool,
      machines: [],
      platform: "windows",
    });

    expect(issue).toBeNull();
    expect(options).toMatchObject({
      path,
      ...(cliTool ? { cliTool } : {}),
      wsl: { remotePath },
    });
  });

  it.each<CliTool>(["codex", "claude"])(
    "keeps %s on local launch without inheriting the workspace provider by default",
    (cliTool) => {
      const workspace = createTestWorkspace({
        path: "D:/workspace-root",
        providerId: "provider-1",
        defaultEnvironment: "local",
      });

      const { options, issue } = resolveWorkspaceLaunchOptions({
        workspace,
        cliTool,
        machines: [],
        platform: "windows",
      });

      expect(issue).toBeNull();
      expect(options).toMatchObject({ path: "D:/workspace-root", cliTool });
      expect(options?.wsl).toBeUndefined();
      expect(options?.providerId).toBeUndefined();
      expect(options?.launchProfileId).toBeUndefined();
    },
  );

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

  it.each<{ label: string; cliTool: CliTool; cliEnvironmentDefaults: Workspace["cliEnvironmentDefaults"] }>([
    {
      label: "falls back to the workspace default when a CLI default is absent",
      cliTool: "codex",
      cliEnvironmentDefaults: { claude: "wsl" },
    },
    {
      label: "ignores CLI defaults for non-Claude/Codex tools",
      cliTool: "gemini",
      cliEnvironmentDefaults: { claude: "wsl", codex: "wsl" },
    },
  ])("$label", ({ cliTool, cliEnvironmentDefaults }) => {
    const workspace = createTestWorkspace({
      path: "D:/workspace-root",
      defaultEnvironment: "local",
      cliEnvironmentDefaults,
    });

    const { options, issue } = resolveWorkspaceLaunchOptions({
      workspace,
      cliTool,
      machines: [],
      platform: "windows",
    });

    expect(issue).toBeNull();
    expect(resolveCliEnvironmentDefault(workspace, cliTool)).toBeUndefined();
    expect(options).toMatchObject({ path: "D:/workspace-root", cliTool });
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

  it.each([
    {
      label: "prefers migrated project WSL path",
      workspace: { path: "D:/workspace-root", wsl: { remotePath: "/home/dev/workspace-root" } },
      project: {
        path: "D:/workspace-root/apps/api",
        wslRemotePath: "/home/dev/workspace-root/apps/api",
      },
      expected: "/home/dev/workspace-root/apps/api",
    },
    {
      label: "derives project WSL path from workspace roots",
      workspace: { path: "D:/workspace-root", wsl: { remotePath: "/home/dev/workspace-root" } },
      project: { path: "D:/workspace-root/apps/web" },
      expected: "/home/dev/workspace-root/apps/web",
    },
    {
      label: "falls back to drive mapping for standalone local project",
      workspace: { path: "D:/workspace-root" },
      project: { path: "D:/workspace-root/apps/web" },
      expected: "/mnt/d/workspace-root/apps/web",
    },
    {
      label: "derives project WSL path from UNC WSL project path without persisted remote path",
      workspace: { path: undefined },
      project: { path: "\\\\wsl.localhost\\Ubuntu\\home\\dev\\workspace-root\\apps\\web" },
      expected: "/home/dev/workspace-root/apps/web",
    },
  ])("$label", ({ workspace, project, expected }) => {
    expect(
      resolveWorkspaceProjectWslPath(
        createTestWorkspace(workspace),
        createTestWorkspaceProject(project),
      ),
    ).toBe(expected);
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

  it.each<{ label: string; workspace: Partial<Workspace> }>([
    {
      label: "workspace default environment is wsl",
      workspace: { defaultEnvironment: "wsl" },
    },
    {
      label: "the CLI default is wsl (after project.ssh is checked)",
      workspace: { defaultEnvironment: "local", cliEnvironmentDefaults: { claude: "wsl" } },
    },
  ])("resolves project launch through WSL when $label", ({ workspace: overrides }) => {
    const workspace = createTestWorkspace({
      path: "D:/workspace-root",
      wsl: { distro: "Ubuntu", remotePath: "/mnt/d/workspace-root" },
      ...overrides,
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

  it("passes explicit providerId / providerSelection / launchProfileId through", () => {
    // 显式 providerId：项目在 WSL 模式下启动
    const projectResult = resolveWorkspaceProjectLaunchOptions({
      workspace: createTestWorkspace({
        path: "D:/workspace-root",
        defaultEnvironment: "wsl",
        wsl: { remotePath: "/mnt/d/workspace-root" },
      }),
      project: createTestWorkspaceProject({ path: "D:/workspace-root/apps/api" }),
      cliTool: "gemini",
      providerId: "provider-gemini",
      machines: [],
      platform: "windows",
    });
    expect(projectResult.issue).toBeNull();
    expect(projectResult.options?.providerId).toBe("provider-gemini");
    expect(projectResult.options?.wsl?.remotePath).toBe("/mnt/d/workspace-root/apps/api");

    // providerSelection=none 透传，且不回落 workspace provider
    const noneResult = resolveWorkspaceLaunchOptions({
      workspace: createTestWorkspace({
        path: "D:/workspace-root",
        providerId: "workspace-provider",
        defaultEnvironment: "local",
      }),
      cliTool: "claude",
      providerSelection: "none",
      machines: [],
      platform: "windows",
    });
    expect(noneResult.issue).toBeNull();
    expect(noneResult.options?.providerId).toBeUndefined();
    expect(noneResult.options?.providerSelection).toBe("none");

    // 显式 launchProfileId 覆盖 workspace 绑定
    const profileResult = resolveWorkspaceLaunchOptions({
      workspace: createTestWorkspace({
        path: "D:/workspace-root",
        launchProfileId: "workspace-profile",
        defaultEnvironment: "local",
      }),
      cliTool: "codex",
      launchProfileId: "selected-profile",
      machines: [],
      platform: "windows",
    });
    expect(profileResult.issue).toBeNull();
    expect(profileResult.options?.launchProfileId).toBe("selected-profile");
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

    it.each<{
      label: string;
      profiles: LaunchProfile[];
      boundId?: string;
      explicitId?: string;
      cliTool: CliTool;
      expected: string;
    }>([
      {
        label: "workspace 绑定的 profile 适用于目标 CLI 时正常传递",
        profiles: [createLaunchProfile({ id: "codex-only", targetTools: ["codex"] })],
        boundId: "codex-only",
        cliTool: "codex",
        expected: "codex-only",
      },
      {
        label: "显式传入的 launchProfileId 不经过滤（保留后端 mismatch 警告）",
        profiles: [createLaunchProfile({ id: "codex-only", targetTools: ["codex"] })],
        explicitId: "codex-only",
        cliTool: "claude",
        expected: "codex-only",
      },
      {
        label: "绑定 profile 在本地列表中不存在时保持原样传递",
        profiles: [],
        boundId: "unknown-profile",
        cliTool: "claude",
        expected: "unknown-profile",
      },
    ])("$label", ({ profiles, boundId, explicitId, cliTool, expected }) => {
      useLaunchProfilesStore.setState({ profiles });
      const workspace = createTestWorkspace({
        path: "D:/workspace-root",
        launchProfileId: boundId,
        defaultEnvironment: "local",
      });

      const { options } = resolveWorkspaceLaunchOptions({
        workspace,
        cliTool,
        launchProfileId: explicitId,
        machines: [],
        platform: "windows",
      });

      expect(options?.launchProfileId).toBe(expected);
    });

    it.each([
      {
        label: "旧数据里 targetRuntime=wsl 的项目绑定 profile 在本机环境仍照常传递（运行位置已弃用）",
        profile: createLaunchProfile({ id: "wsl-only", targetTools: [], targetRuntime: "wsl" }),
        workspace: { path: "D:/workspace-root", defaultEnvironment: "local" as const },
        project: { path: "D:/workspace-root/apps/api", launchProfileId: "wsl-only" },
      },
      {
        label: "旧数据里 targetRuntime=local 的工作空间绑定 profile 在 SSH 项目里仍照常传递",
        profile: createLaunchProfile({ id: "local-only", targetTools: [], targetRuntime: "local" }),
        workspace: {
          path: "D:/workspace-root",
          launchProfileId: "local-only",
          defaultEnvironment: "local" as const,
        },
        project: {
          path: "/srv/app",
          ssh: { host: "box", port: 22, user: "me", remotePath: "/srv/app" },
        },
      },
    ])("$label", ({ profile, workspace, project }) => {
      useLaunchProfilesStore.setState({ profiles: [profile] });

      const { options, issue } = resolveWorkspaceProjectLaunchOptions({
        workspace: createTestWorkspace(workspace),
        project: createTestWorkspaceProject(project),
        cliTool: "claude",
        machines: [],
        platform: "windows",
      });

      expect(issue).toBeNull();
      expect(options?.launchProfileId).toBe(profile.id);
    });
  });
});

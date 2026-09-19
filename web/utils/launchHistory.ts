import type { LaunchRecord } from "@/services";
import type { OpenTerminalOptions, SshMachine, Workspace, WorkspaceProject } from "@/types";
import { stripVerbatimPrefix } from "./path";
import {
  buildSshConnectionDisplayPath,
  resolveWorkspaceProjectLaunchOptions,
} from "./workspaceLaunch";

function optionalValue<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

function normalizeComparePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function findWorkspaceProject(
  workspace: Workspace,
  record: LaunchRecord,
): WorkspaceProject | undefined {
  const target = normalizeComparePath(record.projectPath);
  return workspace.projects.find((project) => {
    if (normalizeComparePath(project.path) === target) {
      return true;
    }
    if (project.ssh) {
      return normalizeComparePath(buildSshConnectionDisplayPath(project.ssh)) === target;
    }
    return false;
  });
}

export function buildLaunchRecordTerminalOptions(
  record: LaunchRecord,
  workspaces: Workspace[],
  machines: SshMachine[],
): OpenTerminalOptions {
  const cliTool = record.cliTool && record.cliTool !== "none" ? record.cliTool : undefined;
  const runtimeKind = record.runtimeKind ?? "local";
  const providerId = optionalValue(record.providerId);
  const providerSelection = optionalValue(record.providerSelection);
  const fallback: OpenTerminalOptions = {
    path: record.projectPath,
    workspaceName: optionalValue(record.workspaceName),
    providerId,
    providerSelection,
    // 兜底剥 `\\?\`：存量历史记录仍可能带被 hook 污染的值（docs/35-unc-path-contamination.md）。
    // cwd 与 workspace 配置根分别还原，避免将 worktree 当作工作空间。
    workspacePath: stripVerbatimPrefix(optionalValue(record.workspacePath)),
    // Old SSH records used a display URI here, which is not a real cwd.
    launchCwd: record.launchCwd?.startsWith("ssh://")
      ? undefined
      : stripVerbatimPrefix(optionalValue(record.launchCwd)),
    cliTool,
    resumeId: optionalValue(record.resumeSessionId),
  };

  if (!record.workspaceName || runtimeKind === "local") {
    return fallback;
  }

  const workspace = workspaces.find((item) => item.name === record.workspaceName);
  if (!workspace) {
    return fallback;
  }

  const effectiveWorkspace =
    runtimeKind === "wsl" && record.wslDistro
      ? {
          ...workspace,
          wsl: {
            ...workspace.wsl,
            distro: record.wslDistro,
          },
        }
      : workspace;

  const project = findWorkspaceProject(effectiveWorkspace, record);
  if (!project) {
    return fallback;
  }

  const environment = runtimeKind === "ssh"
    ? "ssh"
    : runtimeKind === "wsl"
      ? "wsl"
      : "local";

  const { options } = resolveWorkspaceProjectLaunchOptions({
    workspace: effectiveWorkspace,
    project,
    cliTool,
    providerId,
    providerSelection,
    machines,
    environment,
  });

  if (!options) {
    return fallback;
  }

  return {
    ...options,
    launchCwd: fallback.launchCwd,
    resumeId: optionalValue(record.resumeSessionId),
  };
}

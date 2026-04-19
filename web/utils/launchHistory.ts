import type { LaunchRecord } from "@/services";
import type { OpenTerminalOptions, SshMachine, Workspace, WorkspaceProject } from "@/types";
import {
  buildSshConnectionDisplayPath,
  resolveWorkspaceProjectLaunchOptions,
} from "./workspaceLaunch";

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
  const fallback: OpenTerminalOptions = {
    path: record.projectPath,
    workspaceName: record.workspaceName,
    providerId: record.providerId,
    workspacePath: record.launchCwd ?? record.workspacePath,
    cliTool,
    resumeId: record.resumeSessionId,
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
    providerId: record.providerId,
    machines,
    environment,
  });

  if (!options) {
    return fallback;
  }

  return {
    ...options,
    resumeId: record.resumeSessionId,
  };
}

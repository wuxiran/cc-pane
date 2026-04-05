import type {
  CliTool,
  OpenTerminalOptions,
  SshConnectionInfo,
  SshMachine,
  Workspace,
  WorkspaceProject,
  WorkspaceLaunchEnvironment,
} from "@/types";
import { isWslUncPath, toWslPath } from "./path";

export type AppPlatform = "windows" | "macos" | "linux" | "unknown";
export type WorkspaceProjectKind = "local" | "wsl" | "ssh";

export type WorkspaceLaunchIssueCode =
  | "local_path_missing"
  | "wsl_unsupported"
  | "wsl_path_missing"
  | "wsl_local_path_missing"
  | "ssh_machine_missing"
  | "ssh_machine_not_found"
  | "ssh_path_missing";

export interface WorkspaceLaunchIssue {
  environment: WorkspaceLaunchEnvironment;
  code: WorkspaceLaunchIssueCode;
  detail?: string;
}

interface WorkspaceLaunchParams {
  workspace: Workspace;
  cliTool?: CliTool;
  providerId?: string;
  machines: SshMachine[];
  platform?: AppPlatform;
}

export function detectAppPlatform(): AppPlatform {
  if (typeof navigator === "undefined") return "unknown";
  const platform = navigator.platform.toLowerCase();
  if (platform.startsWith("win")) return "windows";
  if (platform.startsWith("mac")) return "macos";
  if (platform.includes("linux")) return "linux";
  return "unknown";
}

export function getWorkspaceDefaultEnvironment(
  workspace: Workspace,
): WorkspaceLaunchEnvironment {
  return workspace.defaultEnvironment ?? "local";
}

export function getWorkspaceProjectKind(project: WorkspaceProject): WorkspaceProjectKind {
  if (project.ssh) return "ssh";
  if (project.wslRemotePath?.trim()) return "wsl";
  if (isWslUncPath(project.path)) return "wsl";
  return "local";
}

export function hasWorkspaceWslPath(workspace: Workspace): boolean {
  if (isWslUncPath(workspace.path)) return true;
  const rootProject = workspace.projects.find((project) => !project.ssh);
  return rootProject ? getWorkspaceProjectKind(rootProject) === "wsl" : false;
}

export function resolveWorkspaceProjectWslPath(
  workspace: Workspace,
  project: WorkspaceProject,
): string | null {
  if (project.ssh) return null;

  if (project.wslRemotePath?.trim()) {
    return project.wslRemotePath.trim();
  }

  const remoteRoot = workspace.wsl?.remotePath?.trim();
  if (!remoteRoot) {
    return toWslPath(project.path);
  }

  const localRoot = workspace.path?.trim();
  if (!localRoot) {
    return null;
  }

  const normalizedLocalRoot = normalizeFilesystemPath(localRoot);
  const normalizedProjectPath = normalizeFilesystemPath(project.path);
  const compareLocalRoot = normalizeComparePath(localRoot);
  const compareProjectPath = normalizeComparePath(project.path);

  if (compareProjectPath === compareLocalRoot) {
    return remoteRoot;
  }

  const prefix = `${compareLocalRoot}/`;
  if (!compareProjectPath.startsWith(prefix)) {
    return toWslPath(project.path);
  }

  const relativePath = normalizedProjectPath.slice(normalizedLocalRoot.length + 1);
  return joinLinuxPath(remoteRoot, relativePath);
}

export function buildSshDisplayPath(machine: SshMachine, remotePath: string): string {
  const userPart = machine.user ? `${machine.user}@` : "";
  const portPart = machine.port !== 22 ? `:${machine.port}` : "";
  const normalizedPath = remotePath.startsWith("/") ? remotePath : `/${remotePath}`;
  return `ssh://${userPart}${machine.host}${portPart}${normalizedPath}`;
}

export function buildSshConnectionDisplayPath(connection: SshConnectionInfo): string {
  const userPart = connection.user ? `${connection.user}@` : "";
  const portPart = connection.port !== 22 ? `:${connection.port}` : "";
  const normalizedPath = connection.remotePath.startsWith("/")
    ? connection.remotePath
    : `/${connection.remotePath}`;
  return `ssh://${userPart}${connection.host}${portPart}${normalizedPath}`;
}

export function getWorkspaceLaunchIssueKey(issue: WorkspaceLaunchIssue): string {
  switch (issue.code) {
    case "local_path_missing":
      return "workspaceEnv.issue.localPathMissing";
    case "wsl_unsupported":
      return "workspaceEnv.issue.wslUnsupported";
    case "wsl_path_missing":
      return "workspaceEnv.issue.wslPathMissing";
    case "wsl_local_path_missing":
      return "workspaceEnv.issue.wslLocalPathMissing";
    case "ssh_machine_missing":
      return "workspaceEnv.issue.sshMachineMissing";
    case "ssh_machine_not_found":
      return "workspaceEnv.issue.sshMachineNotFound";
    case "ssh_path_missing":
      return "workspaceEnv.issue.sshPathMissing";
  }
}

export function getWorkspaceLaunchIssueValues(issue: WorkspaceLaunchIssue): Record<string, string> {
  if (issue.code === "ssh_machine_not_found") {
    return { machineId: issue.detail ?? "" };
  }
  return {};
}

export function getWorkspaceEnvironmentIssue(
  params: WorkspaceLaunchParams & { environment?: WorkspaceLaunchEnvironment },
): WorkspaceLaunchIssue | null {
  return resolveWorkspaceLaunchOptionsInternal(params).issue;
}

export function resolveWorkspaceLaunchOptions(
  params: WorkspaceLaunchParams & { environment?: WorkspaceLaunchEnvironment },
): { options: OpenTerminalOptions | null; issue: WorkspaceLaunchIssue | null } {
  return resolveWorkspaceLaunchOptionsInternal(params);
}

function resolveWorkspaceLaunchOptionsInternal(
  params: WorkspaceLaunchParams & { environment?: WorkspaceLaunchEnvironment },
): { options: OpenTerminalOptions | null; issue: WorkspaceLaunchIssue | null } {
  const platform = params.platform ?? detectAppPlatform();
  const environment = params.environment ?? getWorkspaceDefaultEnvironment(params.workspace);
  const { workspace, machines, cliTool, providerId } = params;
  const effectiveProviderId = cliTool === "codex" ? undefined : (providerId ?? workspace.providerId);

  switch (environment) {
    case "local": {
      const localPath = workspace.path?.trim();
      if (localPath) {
        return {
          options: {
            path: localPath,
            workspaceName: workspace.name,
            providerId: effectiveProviderId,
            workspacePath: workspace.path,
            cliTool,
          },
          issue: null,
        };
      }

      const fallbackProject = workspace.projects.find((project) => !project.ssh);
      if (fallbackProject) {
        return {
          options: {
            path: fallbackProject.path,
            workspaceName: workspace.name,
            providerId: effectiveProviderId,
            workspacePath: workspace.path,
            cliTool,
          },
          issue: null,
        };
      }

      return {
        options: null,
        issue: { environment, code: "local_path_missing" },
      };
    }

    case "wsl": {
      if (platform !== "windows") {
        return {
          options: null,
          issue: { environment, code: "wsl_unsupported" },
        };
      }

      const localPath = workspace.path?.trim();
      const workspaceRemotePath =
        workspace.wsl?.remotePath?.trim() || (localPath ? toWslPath(localPath) ?? undefined : undefined);
      if (localPath && workspaceRemotePath) {
        return {
          options: {
            path: localPath,
            workspaceName: workspace.name,
            providerId: effectiveProviderId,
            workspacePath: workspace.path,
            cliTool,
            wsl: {
              distro: workspace.wsl?.distro?.trim() || undefined,
              remotePath: workspaceRemotePath,
            },
          },
          issue: null,
        };
      }

      const fallbackProject = workspace.projects.find((project) => {
        if (project.ssh) return false;
        return resolveWorkspaceProjectWslPath(workspace, project) !== null;
      });
      if (fallbackProject) {
        return {
          options: {
            path: fallbackProject.path,
            workspaceName: workspace.name,
            providerId: effectiveProviderId,
            workspacePath: workspace.path,
            cliTool,
            wsl: {
              distro: workspace.wsl?.distro?.trim() || undefined,
              remotePath: resolveWorkspaceProjectWslPath(workspace, fallbackProject)!,
            },
          },
          issue: null,
        };
      }

      return {
        options: null,
        issue: localPath
          ? { environment, code: "wsl_path_missing" }
          : { environment, code: "wsl_local_path_missing" },
      };
    }

    case "ssh": {
      const machineId = workspace.sshLaunch?.machineId?.trim();
      const remotePath = workspace.sshLaunch?.remotePath?.trim();
      if (machineId && remotePath) {
        const machine = machines.find((item) => item.id === machineId);
        if (machine) {
          return {
            options: {
              path: buildSshDisplayPath(machine, remotePath),
              workspaceName: workspace.name,
              providerId: effectiveProviderId,
              workspacePath: workspace.path,
              cliTool,
              ssh: {
                host: machine.host,
                port: machine.port,
                user: machine.user,
                remotePath,
                identityFile: machine.identityFile,
              },
              machineName: machine.name,
            },
            issue: null,
          };
        }
      }

      const fallbackProject = workspace.projects.find((project) => !!project.ssh);
      if (fallbackProject?.ssh) {
        const machine = machines.find((item) =>
          item.host === fallbackProject.ssh!.host
          && item.port === fallbackProject.ssh!.port
          && item.user === fallbackProject.ssh!.user
        );
        return {
          options: {
            path: buildSshConnectionDisplayPath(fallbackProject.ssh),
            workspaceName: workspace.name,
            providerId: effectiveProviderId,
            workspacePath: workspace.path,
            cliTool,
            ssh: { ...fallbackProject.ssh },
            machineName: machine?.name ?? fallbackProject.alias,
          },
          issue: null,
        };
      }

      if (!machineId) {
        return {
          options: null,
          issue: { environment, code: "ssh_machine_missing" },
        };
      }
      if (!remotePath) {
        return {
          options: null,
          issue: { environment, code: "ssh_path_missing" },
        };
      }

      return {
        options: null,
        issue: {
          environment,
          code: "ssh_machine_not_found",
          detail: machineId,
        },
      };
    }
  }
}

function normalizeFilesystemPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function normalizeComparePath(path: string): string {
  const normalized = normalizeFilesystemPath(path);
  if (normalized.length >= 2 && normalized[1] === ":") {
    return normalized.toLowerCase();
  }
  return normalized;
}

function joinLinuxPath(root: string, relativePath: string): string {
  if (!relativePath) return root;
  return `${root.replace(/\/+$/, "")}/${relativePath.replace(/^\/+/, "")}`;
}

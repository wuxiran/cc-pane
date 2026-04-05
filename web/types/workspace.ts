/** SSH 连接信息 */
export interface SshConnectionInfo {
  host: string;
  port: number;
  user?: string;
  remotePath: string;
  identityFile?: string;
}

/** 工作空间默认运行环境 */
export type WorkspaceLaunchEnvironment = "local" | "wsl" | "ssh";

/** 工作空间迁移目标类型 */
export type WorkspaceMigrationTargetKind = "local" | "wsl" | "ssh";

/** 工作空间迁移状态 */
export type WorkspaceMigrationStatus = "succeeded" | "rolled_back";

/** 工作空间级 WSL 配置 */
export interface WorkspaceWslConfig {
  distro?: string;
  remotePath?: string;
}

/** 工作空间级 SSH 配置 */
export interface WorkspaceSshLaunchConfig {
  machineId?: string;
  remotePath?: string;
}

export interface WorkspaceProject {
  id: string;
  path: string;
  alias?: string;
  wslRemotePath?: string;
  ssh?: SshConnectionInfo;
}

export interface Workspace {
  id: string;
  name: string;
  alias?: string;
  createdAt: string;
  projects: WorkspaceProject[];
  providerId?: string;
  path?: string;
  defaultEnvironment?: WorkspaceLaunchEnvironment;
  wsl?: WorkspaceWslConfig;
  sshLaunch?: WorkspaceSshLaunchConfig;
  pinned?: boolean;
  hidden?: boolean;
  sortOrder?: number;
}

export interface WorkspaceMigrationRequest {
  workspaceName: string;
  targetKind: WorkspaceMigrationTargetKind;
  targetRoot: string;
  targetDistro?: string;
}

export interface WorkspaceMigrationItem {
  projectId: string;
  projectName: string;
  sourcePath: string;
  destinationPath: string;
  relativePath?: string;
  external: boolean;
}

export interface WorkspaceMigrationPlan {
  workspaceName: string;
  sourceRoot: string;
  rootDestination: string;
  targetKind: WorkspaceMigrationTargetKind;
  targetRoot: string;
  targetDistro?: string;
  items: WorkspaceMigrationItem[];
  warnings: string[];
}

export interface WorkspaceMigrationResult {
  status: WorkspaceMigrationStatus;
  snapshotId: string;
  workspace: Workspace;
  plan: WorkspaceMigrationPlan;
  copiedFiles: number;
  copiedBytes: number;
  warnings: string[];
}

export interface WorkspaceMigrationRollbackResult {
  snapshotId: string;
  workspace: Workspace;
}

export interface ProjectMigrationRequest {
  workspaceName: string;
  projectId: string;
  targetKind: WorkspaceMigrationTargetKind;
  targetRoot: string;
  targetDistro?: string;
}

export interface ProjectMigrationPlan {
  workspaceName: string;
  projectId: string;
  projectName: string;
  sourcePath: string;
  destinationPath: string;
  targetKind: WorkspaceMigrationTargetKind;
  targetRoot: string;
  targetDistro?: string;
  warnings: string[];
}

export interface ProjectMigrationResult {
  status: WorkspaceMigrationStatus;
  snapshotId: string;
  workspace: Workspace;
  plan: ProjectMigrationPlan;
  copiedFiles: number;
  copiedBytes: number;
  warnings: string[];
}

export interface ProjectMigrationRollbackResult {
  snapshotId: string;
  workspace: Workspace;
}

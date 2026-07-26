import type { AuthMethod } from "./ssh-machine";
import type {
  WallpaperMusicSettings,
  WallpaperSettings,
  WallpaperVideoSettings,
} from "./settings";

export const WORKSPACE_COLORS = [
  "red",
  "amber",
  "green",
  "blue",
  "purple",
  "pink",
  "cyan",
  "gray",
] as const;

export type WorkspaceColor = (typeof WORKSPACE_COLORS)[number];

/** 工作空间壁纸覆盖模式：off 必须与 inherit 区分（明确关掉全局壁纸） */
export type WorkspaceWallpaperOverrideMode = "inherit" | "custom" | "off";

/**
 * 工作空间壁纸覆盖配置（镜像 cc-panes-core WallpaperOverrideConfig）。
 * 每个字段都可选：未设 = 回落全局。video/music 也是各自的 Partial，
 * 这样能只覆盖某一个嵌套字段而不整块替换。
 */
export interface WallpaperOverrideConfig
  extends Partial<Omit<WallpaperSettings, "video" | "music">> {
  video?: Partial<WallpaperVideoSettings>;
  music?: Partial<WallpaperMusicSettings>;
}

/** 工作空间级壁纸覆盖 */
export interface WorkspaceWallpaperOverride {
  mode: WorkspaceWallpaperOverrideMode;
  config?: WallpaperOverrideConfig | null;
}

/** SSH 连接信息 */
export interface SshConnectionInfo {
  host: string;
  port: number;
  user?: string;
  remotePath: string;
  identityFile?: string;
  machineId?: string;
  authMethod?: AuthMethod;
}

/** 工作空间默认运行环境 */
export type WorkspaceLaunchEnvironment = "local" | "wsl" | "ssh";

export type CliEnvironmentKey = "claude" | "codex";

export interface WorkspaceCliEnvironmentDefaults {
  claude?: WorkspaceLaunchEnvironment;
  codex?: WorkspaceLaunchEnvironment;
}

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
  launchProfileId?: string;
  wslRemotePath?: string;
  ssh?: SshConnectionInfo;
}

/**
 * 项目路径存在性判定。三态而非布尔：WSL 发行版未运行 / SSH 远程项目无法验证，
 * 判成 missing 会诱导用户误删仍然有效的注册。
 */
export type PathStatusKind = "present" | "missing" | "unverifiable";

export interface ProjectPathStatus {
  projectId: string;
  path: string;
  status: PathStatusKind;
}

export interface Workspace {
  id: string;
  name: string;
  alias?: string;
  createdAt: string;
  projects: WorkspaceProject[];
  providerId?: string;
  launchProfileId?: string;
  path?: string;
  defaultEnvironment?: WorkspaceLaunchEnvironment;
  cliEnvironmentDefaults?: WorkspaceCliEnvironmentDefaults;
  wsl?: WorkspaceWslConfig;
  sshLaunch?: WorkspaceSshLaunchConfig;
  pinned?: boolean;
  hidden?: boolean;
  sortOrder?: number;
  /** 自由分组名；空值表示未分组 */
  group?: string;
  /** 颜色预设键；不持久化具体色值 */
  color?: WorkspaceColor;
  /** 默认工作空间：启动时缺失自动创建，恒置顶，不可删除/拖拽 */
  isDefault?: boolean;
  /** 工作空间壁纸覆盖（inherit/custom/off），存 workspace.json */
  wallpaperOverride?: WorkspaceWallpaperOverride | null;
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

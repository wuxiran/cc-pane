// 其他运行 CC-Panes 的设备（服务器 / 另一台电脑），docs/111-multi-device.md

export type DeviceConnection =
  | { kind: "ssh"; machineId: string; remotePort: number }
  | { kind: "direct"; baseUrl: string };

export interface DeviceSummary {
  id: string;
  name: string;
  connection: DeviceConnection;
  createdAt: string;
  hasToken: boolean;
  /** SSH 设备为 user@host，直连设备为地址 */
  targetLabel: string;
}

export interface DeviceAddRequest {
  name: string;
  connection: DeviceConnection;
  token?: string;
}

export interface DeviceInfo {
  hostname: string | null;
  os: string;
  osVersion: string | null;
  arch: string;
  appVersion: string;
  uptimeSecs: number;
  homeDir: string | null;
  defaultCwd: string;
  headless: boolean;
}

export interface DeviceCliTool {
  id: string;
  displayName?: string;
  installed: boolean;
  version: string | null;
}

export interface DeviceEnvironment {
  node: { installed: boolean; version: string | null };
  git: { installed: boolean; version: string | null };
  cliTools: DeviceCliTool[];
}

export interface DeviceWorkspaceProject {
  id: string;
  path: string;
  alias?: string | null;
}

export interface DeviceWorkspace {
  id: string;
  name: string;
  alias?: string | null;
  path?: string | null;
  projects: DeviceWorkspaceProject[];
}

export interface DeviceSessionStatus {
  sessionId: string;
  status: string;
  lastOutputAt: number;
  runtimeKind?: string | null;
}

export interface DeviceLaunchRecord {
  ptySessionId: string | null;
  projectName: string;
  projectPath: string;
  cliTool: string;
  launchedAt: string;
  workspaceName: string | null;
  lastPrompt: string | null;
}

export type DeviceErrorKind = "ssh" | "unreachable" | "unauthorized" | "error";

export interface DeviceSnapshot {
  deviceId: string;
  online: boolean;
  errorKind: DeviceErrorKind | null;
  error: string | null;
  info: DeviceInfo | null;
  environment: DeviceEnvironment | null;
  workspaces: DeviceWorkspace[] | null;
  sessions: DeviceSessionStatus[] | null;
  launches: DeviceLaunchRecord[] | null;
}

export type DeployStep =
  | "connect"
  | "detect"
  | "download"
  | "upload"
  | "install"
  | "start"
  | "token"
  | "verify"
  | "done";

export interface DeployProgress {
  deviceId: string;
  step: DeployStep;
  detail: string | null;
  fraction: number | null;
}

export interface DeployReport {
  platform: { os: string; arch: string; user: string; installedVersion: string | null };
  previousVersion: string | null;
  version: string;
  manager: "systemd" | "nohup";
  warnings: string[];
}

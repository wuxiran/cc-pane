/**
 * Runner Registry 类型定义
 *
 * 与 Rust 端 `cc-panes-core/src/models/runner.rs` 对齐
 */

export type RunnerRuntimeKind = "local" | "wsl" | "ssh";
export type RunnerInstanceStatus = "running" | "exited" | "orphaned";
export type RunnerLaunchSuggestedAction =
  | "startDirect"
  | "killSelfThenStart"
  | "askUserBeforeKill"
  | "investigateUnknown";

export interface RunnerProfile {
  id: string;
  projectPath: string;
  workspaceName?: string;
  name: string;
  command: string;
  cwd: string;
  runtimeKind: RunnerRuntimeKind;
  wslDistro?: string;
  sshMachineId?: string;
  env: Record<string, string>;
  expectedPorts: number[];
  toolHint?: string;
  lastStartedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** 创建/更新启动配置草稿；id 缺省 = 新建 */
export interface RunnerProfileDraft {
  id?: string;
  projectPath: string;
  workspaceName?: string;
  name: string;
  command: string;
  cwd: string;
  runtimeKind: RunnerRuntimeKind;
  wslDistro?: string;
  sshMachineId?: string;
  env?: Record<string, string>;
  expectedPorts?: number[];
  toolHint?: string;
}

export interface RunnerInstance {
  id: string;
  profileId?: string;
  projectPath: string;
  workspaceName?: string;
  sessionId?: string;
  rootPid: number;
  runtimeKind: RunnerRuntimeKind;
  command: string;
  cwd: string;
  startedAt: string;
  exitedAt?: string;
  exitCode?: number;
  status: RunnerInstanceStatus;
  metadata?: unknown;
}

export interface PortClaim {
  id: number;
  instanceId?: string;
  pid: number;
  port: number;
  protocol: string;
  listenAddr?: string;
  detectedAt: string;
}

export interface PortConflict {
  port: number;
  protocol: string;
  pid: number;
  listenAddr?: string;
  owningInstanceId?: string;
  owningProfileId?: string;
  owningProfileName?: string;
}

export interface RunnerLaunchPlan {
  profileId: string;
  profileName: string;
  conflicts: PortConflict[];
  suggestedActions: RunnerLaunchSuggestedAction[];
}

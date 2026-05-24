/**
 * Runner Registry 前端服务层 — 封装 Tauri invoke
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  PortClaim,
  PortConflict,
  RunnerInstance,
  RunnerLaunchPlan,
  RunnerProfile,
  RunnerProfileDraft,
} from "@/types/runner";

export const runnerService = {
  /** 列出某项目的启动配置（按 lastStartedAt 倒序） */
  async listProfiles(projectPath: string): Promise<RunnerProfile[]> {
    return invoke<RunnerProfile[]>("runner_list_profiles", { projectPath });
  },

  /** 获取单个 profile */
  async getProfile(id: string): Promise<RunnerProfile | null> {
    return invoke<RunnerProfile | null>("runner_get_profile", { id });
  },

  /** 新建或更新 profile（draft.id 为空 = 新建） */
  async upsertProfile(draft: RunnerProfileDraft): Promise<RunnerProfile> {
    return invoke<RunnerProfile>("runner_upsert_profile", { draft });
  },

  async deleteProfile(id: string): Promise<void> {
    await invoke<void>("runner_delete_profile", { id });
  },

  /** 启动前预演 */
  async planLaunch(profileId: string): Promise<RunnerLaunchPlan> {
    return invoke<RunnerLaunchPlan>("runner_plan_launch", { profileId });
  },

  /** 当前活跃运行实例 */
  async listActiveInstances(
    projectPath?: string,
  ): Promise<RunnerInstance[]> {
    return invoke<RunnerInstance[]>("runner_list_active_instances", {
      projectPath: projectPath ?? null,
    });
  },

  /** 查询给定端口的当前占用情况 */
  async listPortConflicts(ports: number[]): Promise<PortConflict[]> {
    return invoke<PortConflict[]>("runner_list_port_conflicts", { ports });
  },

  /** 刷新某 instance 的 port_claims（用 sysinfo 扫子进程树 ∩ netstat2） */
  async refreshPortClaims(instanceId: string): Promise<PortClaim[]> {
    return invoke<PortClaim[]>("runner_refresh_port_claims", { instanceId });
  },

  async markInstanceExited(
    instanceId: string,
    exitCode?: number,
    orphaned?: boolean,
  ): Promise<void> {
    await invoke<void>("runner_mark_instance_exited", {
      instanceId,
      exitCode: exitCode ?? null,
      orphaned: orphaned ?? null,
    });
  },

  /** 杀掉 instance 的根进程树 */
  async killInstance(instanceId: string): Promise<boolean> {
    return invoke<boolean>("runner_kill_instance", { instanceId });
  },

  /** 按 PID 杀进程（薄包装；用于 skill 决定杀某个具体端口占用方） */
  async killPid(pid: number): Promise<boolean> {
    return invoke<boolean>("runner_kill_pid", { pid });
  },

  /** UI 编排专用：根据 session_id 反查 PID 后登记为 runner instance。
   *  典型流程：createTerminalSession → submit command → registerForSession。
   *  profileId 提供则刷新 last_started_at。
   */
  async registerForSession(args: {
    sessionId: string;
    projectPath: string;
    workspaceName?: string;
    profileId?: string;
    runtimeKind: string;
    command: string;
    cwd: string;
  }): Promise<RunnerInstance> {
    return invoke<RunnerInstance>("runner_register_for_session", {
      ...args,
      workspaceName: args.workspaceName ?? null,
      profileId: args.profileId ?? null,
    });
  },

  /** 隐式扫描入口：hook 上报或 UI 手动同步 */
  async registerImplicitInstance(args: {
    projectPath: string;
    workspaceName?: string;
    sessionId?: string;
    rootPid: number;
    runtimeKind: string;
    command: string;
    cwd: string;
  }): Promise<RunnerInstance> {
    return invoke<RunnerInstance>("runner_register_implicit_instance", {
      ...args,
      workspaceName: args.workspaceName ?? null,
      sessionId: args.sessionId ?? null,
    });
  },
};

// 启动器草稿模型 + PendingLaunch 构建（纯逻辑，无 React）。
// 工作空间项目走 resolveWorkspaceProjectLaunchOptions（与空态大按钮组同一条解析链），
// 手动目录 / 最近启动直接拼 PendingLaunch。产物必须经 useDialogStore.setPendingLaunch
// 全局通道消费——禁止在 Dialog 内挂 useOpenTerminal（pendingLaunch 双消费）。
import type {
  CliTool,
  LaunchAdapterOptions,
  LaunchEffort,
  LaunchProviderSelection,
  OpenTerminalOptions,
  SshMachine,
  Workspace,
  WorkspaceLaunchEnvironment,
} from "@/types";
import type { PendingLaunch } from "@/stores/useDialogStore";
import {
  resolveWorkspaceProjectLaunchOptions,
  type WorkspaceLaunchIssue,
} from "@/utils/workspaceLaunch";

/** 项目来源：工作空间项目 / 最近启动还原出的 options / 手动目录 */
export type LauncherProjectSource =
  | { kind: "workspace"; workspaceId: string; projectId: string }
  | { kind: "recent"; options: OpenTerminalOptions; label: string }
  | { kind: "manual"; path: string };

/** 注入目标：拼进追加系统提示（默认）或初始 prompt */
export type LauncherInjectionTarget = "append" | "initial";

export interface LauncherWorktreeDraft {
  enabled: boolean;
  branch: string;
}

export interface LauncherDraft {
  source: LauncherProjectSource | null;
  cliTool: CliTool;
  environment: WorkspaceLaunchEnvironment;
  /** 两态 chip：undefined = 跟随 profile，true = 本次强制 YOLO */
  yolo?: true;
  /** undefined = default 档（不注入） */
  effort?: LaunchEffort;
  appendSystemPrompt: string;
  initialPrompt: string;
  skipMcp: boolean;
  verbose: boolean;
  maxTurns?: number;
  providerSelection: LaunchProviderSelection;
  providerId?: string;
  launchProfileId?: string;
  /** undefined = 自动（findLayoutForWorkspace 推导） */
  targetLayoutId?: string;
  /** 场景模板：选择即一次性覆写字段（applyScenario），后续手改不回弹 */
  scenarioId?: string;
  /** 最近一次注入的展示信息（内容已并入 appendSystemPrompt/initialPrompt） */
  injection?: { label: string; target: LauncherInjectionTarget };
  /** worktree 启动：提交时先 worktreeService.add 再用返回路径替换 PendingLaunch.path */
  worktree?: LauncherWorktreeDraft;
}

/**
 * 校验「默认 CLI 工具」设置值：命中 CLI_TOOL_TABS 才采用，脏配置回落 null。
 * 实现已收口到 @/utils/cliTool（与 ProvidersPanel 共用同一份），此处保留启动器语境下的别名。
 */
export { coerceCliTool as coerceDefaultCliTool } from "@/utils/cliTool";

export function createDefaultDraft(partial?: Partial<LauncherDraft>): LauncherDraft {
  return {
    source: null,
    environment: "local",
    appendSystemPrompt: "",
    initialPrompt: "",
    skipMcp: false,
    verbose: false,
    providerSelection: "inherit",
    ...partial,
    // 优先级：调用点显式传入（用户选择 / 默认设置）> 硬编码回落。
    // 写在展开之后：显式 undefined 不得抹掉回落值。
    cliTool: partial?.cliTool ?? "claude",
  };
}

/** effort/verbose/maxTurns 收拢为 adapterOptions；全部缺省时返回 undefined */
export function buildAdapterOptions(draft: LauncherDraft): LaunchAdapterOptions | undefined {
  const options: LaunchAdapterOptions = {};
  if (draft.effort) options.effort = draft.effort;
  if (draft.verbose) options.verbose = true;
  if (draft.maxTurns !== undefined && draft.maxTurns > 0) options.maxTurns = draft.maxTurns;
  return Object.keys(options).length > 0 ? options : undefined;
}

export type BuildPendingLaunchResult =
  | { launch: PendingLaunch; issue: null }
  | { launch: null; issue: WorkspaceLaunchIssue | { code: "no_project" } };

interface BuildDeps {
  workspaces: Workspace[];
  machines: SshMachine[];
}

/** 把草稿变成 PendingLaunch；工作空间来源解析失败时返回 issue（调用方 toast，不启动） */
export function buildPendingLaunch(
  draft: LauncherDraft,
  deps: BuildDeps,
): BuildPendingLaunchResult {
  const base = resolveBaseOptions(draft, deps);
  if ("issue" in base) return { launch: null, issue: base.issue };

  const options = base.options;
  const appendSystemPrompt = draft.appendSystemPrompt.trim() || undefined;
  const initialPrompt = draft.initialPrompt.trim() || undefined;
  return {
    launch: {
      path: options.path,
      workspaceName: options.workspaceName,
      workspacePath: options.workspacePath,
      providerId:
        (draft.providerSelection === "explicit" ? draft.providerId : options.providerId) ?? "",
      providerSelection: draft.providerSelection,
      launchProfileId: draft.launchProfileId ?? options.launchProfileId,
      cliTool: draft.cliTool,
      ssh: options.ssh,
      wsl: options.wsl,
      machineName: options.machineName,
      targetLayoutId: draft.targetLayoutId,
      skipMcp: draft.skipMcp || undefined,
      appendSystemPrompt,
      initialPrompt,
      yolo: draft.yolo,
      adapterOptions: buildAdapterOptions(draft),
    },
    issue: null,
  };
}

function resolveBaseOptions(
  draft: LauncherDraft,
  deps: BuildDeps,
): { options: OpenTerminalOptions } | { issue: WorkspaceLaunchIssue | { code: "no_project" } } {
  const source = draft.source;
  if (!source) return { issue: { code: "no_project" } };

  if (source.kind === "manual") {
    const path = source.path.trim();
    if (!path) return { issue: { code: "no_project" } };
    // 手动目录只支持本地环境（无工作空间上下文可解析 WSL/SSH 路径）
    return { options: { path, cliTool: draft.cliTool } };
  }

  if (source.kind === "recent") {
    // 最近启动已还原完整环境（WSL distro / SSH 机器）；启动器始终开全新会话
    return { options: { ...source.options, resumeId: undefined, cliTool: draft.cliTool } };
  }

  const workspace = deps.workspaces.find((ws) => ws.id === source.workspaceId);
  const project = workspace?.projects.find((item) => item.id === source.projectId);
  if (!workspace || !project) return { issue: { code: "no_project" } };

  const { options, issue } = resolveWorkspaceProjectLaunchOptions({
    workspace,
    project,
    cliTool: draft.cliTool,
    providerId: draft.providerSelection === "explicit" ? draft.providerId : undefined,
    providerSelection: draft.providerSelection,
    launchProfileId: draft.launchProfileId,
    machines: deps.machines,
    environment: project.ssh ? undefined : draft.environment,
  });
  if (!options) return { issue: issue ?? { code: "no_project" } };
  return { options };
}

/** 当前草稿解析出的本地磁盘项目路径（worktree 检测 / Skill 列表用） */
export function resolveDraftProjectPath(
  draft: LauncherDraft,
  workspaces: Workspace[],
): string | undefined {
  const source = draft.source;
  if (!source) return undefined;
  if (source.kind === "manual") return source.path.trim() || undefined;
  if (source.kind === "recent") return source.options.path;
  const workspace = workspaces.find((ws) => ws.id === source.workspaceId);
  return workspace?.projects.find((project) => project.id === source.projectId)?.path;
}

/** 草稿是否为本地环境启动（worktree 仅本地可用；WSL/SSH 的路径不在本机语义下） */
export function isDraftLocalEnvironment(draft: LauncherDraft, workspaces: Workspace[]): boolean {
  const source = draft.source;
  if (!source) return false;
  if (source.kind === "manual") return true;
  if (source.kind === "recent") return !source.options.ssh && !source.options.wsl;
  const workspace = workspaces.find((ws) => ws.id === source.workspaceId);
  const project = workspace?.projects.find((item) => item.id === source.projectId);
  if (!project) return false;
  return !project.ssh && draft.environment === "local";
}

/** worktree 默认分支名：cc/<yyMMdd-HHmm> */
export function defaultWorktreeBranch(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = `${pad(now.getFullYear() % 100)}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  return `cc/${date}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** 分支名 → worktree 目录名（add_worktree 的 name 参数不接受路径分隔符） */
export function worktreeNameFromBranch(branch: string): string {
  const name = branch.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
  return name || "cc-worktree";
}

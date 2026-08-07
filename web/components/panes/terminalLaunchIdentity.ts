import type { CliTool, SshConnectionInfo, WslLaunchInfo } from "@/types";
import { isPendingPhase, phaseOf } from "@/lib/terminalRuntimePhase";

/**
 * 一次 PTY 启动的身份与形态解析（纯函数，无副作用）。
 *
 * 从 TerminalView 抽出：这几个判定是「本次启动是谁、跑在哪」的定义，与终端渲染无关，
 * 单独放一处才能被直接单测——`launchId` 复用与否是 resume id 能否落库的前提
 * （docs/69：tab 手里的 id 是**上一次** launch 的，复用它去 bind 必然落空）。
 */

/** 生成一个一次性 launch id，保证与 `previous` 不同。 */
export function nextLaunchId(previous?: string): string {
  let launchId: string;
  do {
    launchId = `launch-${crypto.randomUUID()}`;
  } while (launchId === previous);
  return launchId;
}

export interface ResolveLaunchIdOptions {
  /** leaf 上预留或上次使用的 launch id。 */
  launchId?: string;
  /** 恢复路径：原 launch id 已被上次的 PTY 占用，必须换新的。 */
  restoring?: boolean;
  /**
   * 恢复目标会话 id。restoring 标志与它不总是同步（快照落盘时 leaf 已退出的场景
   * restoring 为 falsy），phaseOf 把「有 savedSessionId 未 attach」也判为恢复态，
   * 此处必须同口径——否则会复用上一次的 launch id。
   */
  savedSessionId?: string;
  /** 启动失败后的重挂载次数：失败那次的身份不能复用。 */
  launchAttempt?: number;
  /** 无条件换新（relaunch 路径）。 */
  forceNew?: boolean;
}

/**
 * 决定本次启动用哪个 launch id。
 *
 * 只有「首次启动且 leaf 上已预留了 id」才复用，其余一律换新——复用一个已被占用的
 * launch id 会让 `bind_pty_session` 落空（那行的 `pty_session_id` 不满足
 * `IS NULL OR = 本次`），resume id 就此永久丢失且不可自愈。
 *
 * 恢复态判定统一走 `phaseOf`（恢复态的唯一派生点），不在此处自行组合
 * restoring/savedSessionId——两处口径不一致正是 launchId 复用暗雷的成因。
 */
export function resolveLaunchId(options: ResolveLaunchIdOptions): string {
  const { launchId, restoring, savedSessionId, launchAttempt, forceNew } = options;
  const phase = phaseOf({ restoring, savedSessionId, launchAttempt });
  if (forceNew || isPendingPhase(phase)) {
    return nextLaunchId(launchId);
  }
  return launchId ?? nextLaunchId();
}

/** props 上的 `cliTool` 缺省时回退到旧的 `launchClaude` 布尔。 */
export function resolveCliTool(cliTool?: CliTool, launchClaude?: boolean): string {
  return cliTool ?? (launchClaude ? "claude" : "none");
}

/** 本次启动跑在哪个运行时上。 */
export function resolveRuntimeKind(
  ssh?: SshConnectionInfo,
  wsl?: WslLaunchInfo,
): "local" | "wsl" | "ssh" {
  if (ssh) return "ssh";
  if (wsl) return "wsl";
  return "local";
}

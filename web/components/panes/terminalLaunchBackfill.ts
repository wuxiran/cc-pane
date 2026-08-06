// launch history backfill 的调用收敛（docs/78 批4）。
//
// TerminalView 的两条 spawn 路径（init / 延迟恢复）此前各写一份逐字相同的
// 8 参数调用 + 同一段守卫注释。参数顺序全是同类型的位置参数（launchId /
// sessionId / cliTool / runtimeKind / distro / projectPath / workspacePath /
// afterTs 里有 6 个是 string），错位一个不会报错、只会写错一行历史。
import { historyService } from "@/services";
import type { WslLaunchInfo } from "@/types";

export interface LaunchBackfillInput {
  /** 本次创建 PTY 前刚落到 leaf 的 one-shot launch id（docs/69）。 */
  createdLaunchId: string | undefined;
  sessionId: string;
  cliTool: string;
  runtimeKind: string;
  projectPath: string;
  workspacePath?: string;
  wsl?: WslLaunchInfo;
  /** 创建开始时刻，用于只回填这次之后的历史行。 */
  backfillStartTime: string;
}

/**
 * 带 resumeId 恢复的会话同样要跑 backfill；必须绑定**这次**新建 PTY 的 one-shot
 * launch id，不能退回 tab 级稳定字段或恢复快照里的旧值（docs/69：复用会让
 * `bind_pty_session` 落空，resume id 永久丢失且不可自愈）。
 *
 * 两条短路：无 launchId 不发；`cliTool === "none"` 不发——纯 shell 没有 resume
 * 语义。backfill 内部对「行已有 resume_session_id」会提前退出，不覆盖已绑定值。
 */
export function startLaunchBackfillIfNeeded(input: LaunchBackfillInput): void {
  const { createdLaunchId, cliTool, runtimeKind, wsl } = input;
  if (cliTool === "none" || !createdLaunchId) return;
  void historyService.startLaunchHistoryBackfill(
    createdLaunchId,
    input.sessionId,
    cliTool,
    runtimeKind,
    wsl?.distro,
    wsl?.remotePath ?? input.projectPath,
    runtimeKind === "wsl" ? undefined : input.workspacePath,
    input.backfillStartTime,
  ).catch(console.error);
}

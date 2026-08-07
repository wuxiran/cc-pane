import { useResumeBindingStore } from "@/stores/useResumeBindingStore";
import { sessionRestoreService } from "@/services/sessionRestoreService";
import { getErrorMessage } from "@/utils";

type RestoreLogger = (event: string, extra?: Record<string, unknown>) => void;

/**
 * 决定"创建新会话"时使用的 resume id。
 *
 * 契约：resume id 只能来自「本会话的绑定镜像（ResumeBindingStore，按
 * savedSessionId 精确命中）→ tab / snapshot / props 链（`props.resumeId`）」。
 * 严禁在此按目录查询 launch history 兜底——那会把用户"主动新建"劫持成"resume"
 * （回归 bug：右键启动自动恢复上次会话，引入于 commit 65c9a2f）。
 *
 * ResumeBindingStore 命中不违反上述契约：它按 PTY 会话 id 精确路由，只会返回
 * 「正在恢复的这一个会话」自己的最新绑定，不存在按目录劫持的可能；快照里的
 * `props.resumeId` 是落盘时机决定的副本，store 值永远不旧于它。
 *
 * 这是"新建会话该用哪个 resumeId"的唯一决策点：未来若有人想再次引入历史兜底，
 * 必须改这里，并会被 terminalResume.test.ts 的回归断言拦下。
 */
export function pickCreateSessionResumeId(props: {
  resumeId?: string;
  savedSessionId?: string;
}): string | undefined {
  if (props.savedSessionId) {
    const bound = useResumeBindingStore.getState().getBinding(props.savedSessionId);
    if (bound) return bound.resumeId;
  }
  return props.resumeId;
}

/**
 * 冷恢复：把 `sessions/<savedSessionId>.output` 的纯文本重放进 xterm。
 * 注意这条读路径没有 epoch/世代校验（docs/86 B2）——时效性靠写侧
 * （daemon 退出落盘）与失败清理（下面的 clearColdReplayOutputOnFailure）保证。
 */
export async function replayColdRestoreOutput(
  term: { writeln: (line: string) => void },
  savedSessionId: string,
  logRestoreEvent: RestoreLogger,
  debugLog: RestoreLogger,
): Promise<void> {
  try {
    logRestoreEvent("init.output-replay.begin", { savedSessionId });
    const lines = await sessionRestoreService.loadOutput(savedSessionId);
    logRestoreEvent("init.output-replay.end", { lineCount: lines?.length ?? 0 });
    if (lines && lines.length > 0) {
      debugLog("session.restore.replay", { savedSessionId, lineCount: lines.length });
      term.writeln("\x1b[90m--- Session restored ---\x1b[0m");
      for (const line of lines) {
        term.writeln(line);
      }
      term.writeln("");
    }
  } catch (err) {
    logRestoreEvent("init.output-replay.failed", { error: getErrorMessage(err) });
    console.warn("[TerminalView] Failed to load restored output:", err);
  }
}

/**
 * 终态失败时清掉冷重放缓存（docs/86 B2）：留着的话下次重启会原样重放同一份
 * 旧画面（无时效校验），且 savedSessionId 不清即可无限循环。
 * cancelled（稍后再试）路径**不得**调用——画面还该在。
 */
export function clearColdReplayOutputOnFailure(
  savedSessionId: string | undefined,
  logRestoreEvent: RestoreLogger,
  event: string,
): void {
  if (!savedSessionId) return;
  sessionRestoreService.clearOutput(savedSessionId).catch(console.error);
  logRestoreEvent(event);
}

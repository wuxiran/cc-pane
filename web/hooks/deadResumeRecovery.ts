// resume 目标已不存在（Claude `No conversation found` 等）后的自愈：撤掉死 resume id，
// 并在原位自动新建一次会话，不再让用户手动重启标签。
import i18n from "@/i18n";
import { usePanesStore } from "@/stores/usePanesStore";
import { useResumeBindingStore } from "@/stores/useResumeBindingStore";
import { writeTerminalRestoreLog as writeRestoreLog } from "@/stores/useTerminalRestoreLogStore";

export type DeadResumeOutcome = "relaunched" | "stopped" | "retired" | "not-found";

/**
 * 防循环：同一个 leaf 在本次运行（一次恢复周期）里只自动新建一次。撤掉 resume id 后
 * 新建的会话不带 `--resume`，按理不会再触发本流程；万一又来（迟到的绑定把死 id
 * 写了回来等），就停下来给错误面板，交给用户决定。新建本身失败（createSession 报错）
 * 走既有的 onLaunchError → LaunchErrorPanel，同样不会再自动重试。
 */
const autoRelaunchedLeaves = new Set<string>();

/** 测试用：清空防循环记录。 */
export function resetDeadResumeRecoveryForTest(): void {
  autoRelaunchedLeaves.clear();
}

export function recoverFromDeadResume(ptySessionId: string, deadResumeId: string): DeadResumeOutcome {
  // 绑定已换成别的 id（/clear 后的新会话等）就不动：clearBinding 会连新 id 一起删。
  const binding = useResumeBindingStore.getState().getBinding(ptySessionId);
  if (!binding || binding.resumeId === deadResumeId) {
    useResumeBindingStore.getState().clearBinding(ptySessionId, deadResumeId);
  }
  const panes = usePanesStore.getState();
  const location = panes.retireDeadResumeId(ptySessionId, deadResumeId);
  if (!location) return "not-found";
  const { tabId, terminalPaneId } = location;
  if (!terminalPaneId) return "retired";

  const key = `${tabId}:${terminalPaneId}`;
  if (autoRelaunchedLeaves.has(key)) {
    // 先摘掉已退出的会话（错误面板只挂在无会话的 leaf 上），重试按钮走 retryTerminalLaunch。
    panes.beginTerminalRelaunch(tabId, terminalPaneId, ptySessionId);
    panes.setTerminalLaunchError(tabId, terminalPaneId, {
      message: i18n.t("panes:resumeTargetMissingLoop"),
    });
    writeRestoreLog(tabId, terminalPaneId, "dead-resume.stopped", { resumeId: deadResumeId });
    return "stopped";
  }
  // 旧进程已退出，不需要 kill：摘掉 sessionId（之后到达的 exit 事件找不到它，
  // 不会关标签），再按「重启并续接」同一套路递增 launchAttempt 原位重挂载。
  const previousSessionId = panes.beginTerminalRelaunch(tabId, terminalPaneId, ptySessionId);
  if (!previousSessionId) return "retired";
  autoRelaunchedLeaves.add(key);
  panes.finishTerminalRelaunch(tabId, terminalPaneId, previousSessionId, true);
  writeRestoreLog(tabId, terminalPaneId, "dead-resume.relaunch", { resumeId: deadResumeId });
  return "relaunched";
}

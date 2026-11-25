// 后台注意标记的接线（docs/78 §2.1 onAttention）。
//
// 发射：会话跃迁到 exited / error / waitingInput 且其标签**当前不可见**时打标。
// agent 一轮跑完（hook 忙碌态 → idle，且忙碌持续 ≥ MIN_BUSY_FOR_DONE_MS）也算「完成」——
// 这正是最需要回头看的情况。只认 hook 主导的细分忙碌态：legacy `active` 是 PTY 输出推断，
// 普通 shell 里跑 dev server 会 active/idle 反复横跳，算进来就是刷屏。
//
// 附带职责：状态跃迁时写 useStatusSinceStore（任务视图的时长显示）。
// 可见时不打——用户自己看得见，标记纯属噪声。
//
// 清除：**订阅可见性聚合，anyVisible 翻 true 即清**。不挂任何 UI 点击路径——
// 「看到了」的判据就是「它可见了」，与用户从哪条路径切过去无关（点标签、
// 快捷键、openStarredTab 全都自然覆盖）。
import { useEffect } from "react";
import { usePanesStore } from "@/stores";
import { useTabAttentionStore, type AttentionReason } from "@/stores/useTabAttentionStore";
import { useTabViewStateStore } from "@/stores/useTabViewStateStore";
import { useTerminalStatusStore } from "@/stores/useTerminalStatusStore";
import { useStatusSinceStore } from "@/stores/useStatusSinceStore";
import { isBusyStatus, type TerminalStatusType } from "@/types/settings";

/** 忙碌不足这么久就回到 idle 的不算「跑完一轮」（启动握手、秒回的闲聊）。 */
export const MIN_BUSY_FOR_DONE_MS = 3000;

/** hook 主导的忙碌态（不含 legacy `active`，见文件头）。 */
const AGENT_BUSY: ReadonlySet<TerminalStatusType> = new Set(["thinking", "toolRunning", "compacting"]);

/**
 * 状态跃迁 → 注意原因。不在表里的跃迁不产生标记。
 * @param prev 跃迁前状态（首次见到该会话时为 undefined）
 * @param busyMs 跃迁前连续处于忙碌态的时长；非忙碌跃迁传 0
 */
export function attentionReasonOf(
  status: TerminalStatusType,
  prev?: TerminalStatusType,
  busyMs = 0,
): AttentionReason | null {
  if (status === "error") return "error";
  if (status === "waitingInput") return "waiting-input";
  if (status === "exited") return "completed";
  if (status === "idle" && prev && AGENT_BUSY.has(prev) && busyMs >= MIN_BUSY_FOR_DONE_MS) {
    return "completed";
  }
  return null;
}

/** App 级挂载一次。 */
export function useTabAttentionWiring(): void {
  useEffect(() => {
    const lastStatus = new Map<string, TerminalStatusType>();
    const sinceStore = useStatusSinceStore.getState();

    const handle = (state: ReturnType<typeof useTerminalStatusStore.getState>) => {
      const now = Date.now();
      for (const [sessionId, info] of state.statusMap) {
        const prev = lastStatus.get(sessionId);
        lastStatus.set(sessionId, info.status);
        if (prev === info.status) continue;

        // 忙碌态之间互切（thinking ↔ toolRunning）不重置起点：用户关心的是「这一轮跑了多久」
        const prevSince = useStatusSinceStore.getState().since[sessionId];
        const stayBusy = isBusyStatus(prev) && isBusyStatus(info.status);
        if (!stayBusy || prevSince === undefined) sinceStore.setSince(sessionId, now);

        const busyMs = isBusyStatus(prev) && prevSince !== undefined ? now - prevSince : 0;
        const reason = attentionReasonOf(info.status, prev, busyMs);
        if (!reason) continue;

        const location = usePanesStore.getState().findTabBySessionAcrossLayouts(sessionId);
        if (!location) continue;
        const owner = location.tab.id;

        const visible = useTabViewStateStore.getState().aggregate[owner]?.anyVisible ?? false;
        if (visible) continue;

        useTabAttentionStore.getState().markAttention(owner, reason);
      }
      // 条目消失的会话（被清理）不留判定残渣
      const gone: string[] = [];
      for (const sessionId of [...lastStatus.keys()]) {
        if (!state.statusMap.has(sessionId)) {
          lastStatus.delete(sessionId);
          gone.push(sessionId);
        }
      }
      if (gone.length > 0) sinceStore.remove(gone);
    };

    // 挂载时已有的会话也要有起点（否则任务视图对它们没有时长）
    handle(useTerminalStatusStore.getState());
    const unsubStatus = useTerminalStatusStore.subscribe(handle);

    const unsubView = useTabViewStateStore.subscribe((state) => {
      const attention = useTabAttentionStore.getState();
      for (const owner of Object.keys(attention.entries)) {
        if (state.aggregate[owner]?.anyVisible) {
          attention.clearAttention(owner);
        }
      }
    });

    return () => {
      unsubStatus();
      unsubView();
    };
  }, []);
}

// 后台注意标记的接线（docs/78 §2.1 onAttention）。
//
// 发射：会话跃迁到 exited / error / waitingInput 且其标签**当前不可见**时打标。
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
import type { TerminalStatusType } from "@/types/settings";

/** 状态 → 注意原因。不在表里的状态不产生标记。 */
export function attentionReasonOf(status: TerminalStatusType): AttentionReason | null {
  if (status === "error") return "error";
  if (status === "waitingInput") return "waiting-input";
  if (status === "exited") return "completed";
  return null;
}

/** App 级挂载一次。 */
export function useTabAttentionWiring(): void {
  useEffect(() => {
    const lastStatus = new Map<string, TerminalStatusType>();

    const unsubStatus = useTerminalStatusStore.subscribe((state) => {
      for (const [sessionId, info] of state.statusMap) {
        const prev = lastStatus.get(sessionId);
        lastStatus.set(sessionId, info.status);
        if (prev === info.status) continue;

        const reason = attentionReasonOf(info.status);
        if (!reason) continue;

        const location = usePanesStore.getState().findTabBySessionAcrossLayouts(sessionId);
        if (!location) continue;
        const owner = location.tab.id;

        const visible = useTabViewStateStore.getState().aggregate[owner]?.anyVisible ?? false;
        if (visible) continue;

        useTabAttentionStore.getState().markAttention(owner, reason);
      }
      // 条目消失的会话（被清理）不留判定残渣
      for (const sessionId of [...lastStatus.keys()]) {
        if (!state.statusMap.has(sessionId)) lastStatus.delete(sessionId);
      }
    });

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

// 右下角统一通知中心：update 卡（置顶、保留独立状态机）+ 通知卡片栈 + 历史面板。
// 职责：持有 fixed 定位容器；新通知过闸门后准入栈；调度自动消失。
// 被闸门挡下的通知不丢——已在历史里（未读），StatusBar 铃铛 badge 可见。
import { useEffect, useRef } from "react";
import UpdateNotification from "@/components/update/UpdateNotification";
import { checkInterruptGateLive } from "@/lib/interruptGate";
import { autoDismissMs, classifyNotification } from "@/lib/notificationTaxonomy";
import { useMiniModeStore } from "@/stores";
import { useNotificationStore } from "@/stores/useNotificationStore";
import NotificationHistoryPanel from "./NotificationHistoryPanel";
import NotificationToastStack from "./NotificationToastStack";

export default function NotificationCenter() {
  const isMiniMode = useMiniModeStore((state) => state.isMiniMode);
  const notifications = useNotificationStore((state) => state.notifications);
  const activeToastIds = useNotificationStore((state) => state.activeToastIds);
  const historyOpen = useNotificationStore((state) => state.historyOpen);
  // 已做过准入判定的通知（无论过没过闸门）不再重判：被挡的静默留在历史，不补弹
  const processedIdsRef = useRef<Set<string>>(new Set());
  // 每张卡的入栈时刻，自动消失的计时基准
  const shownAtRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const { showToast } = useNotificationStore.getState();
    for (const record of notifications) {
      if (processedIdsRef.current.has(record.id)) continue;
      processedIdsRef.current.add(record.id);
      if (record.read) continue; // sessionStorage 恢复的历史不重新弹
      const { interruptClass } = classifyNotification(record);
      if (checkInterruptGateLive(interruptClass) !== null) continue;
      shownAtRef.current.set(record.id, Date.now());
      showToast(record.id);
    }
    // 防泄漏：ring 截断后同步收缩
    if (processedIdsRef.current.size > 300) {
      const alive = new Set(notifications.map((n) => n.id));
      processedIdsRef.current = new Set(
        [...processedIdsRef.current].filter((id) => alive.has(id)),
      );
    }
  }, [notifications]);

  // 自动消失：info/success 按入栈时刻 + 8s；askInput 已回传后按 respondedAt + 8s
  useEffect(() => {
    const timers: number[] = [];
    const now = Date.now();
    for (const id of activeToastIds) {
      const record = notifications.find((n) => n.id === id);
      if (!record) continue;
      const classification = classifyNotification(record);
      let dismissAt: number | null = null;
      if (record.respondedAt !== undefined) {
        dismissAt = record.respondedAt + 8_000;
      } else {
        const ttl = autoDismissMs(classification);
        if (ttl !== null) {
          dismissAt = (shownAtRef.current.get(id) ?? now) + ttl;
        }
      }
      if (dismissAt === null) continue;
      timers.push(
        window.setTimeout(() => {
          useNotificationStore.getState().dismissToast(id);
          shownAtRef.current.delete(id);
        }, Math.max(0, dismissAt - now)),
      );
    }
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [activeToastIds, notifications]);

  if (isMiniMode) return null;

  return (
    <div
      data-testid="notification-center"
      className="fixed bottom-11 right-3 z-40 flex w-[min(380px,calc(100vw-24px))] flex-col items-stretch gap-2"
    >
      {historyOpen ? (
        <NotificationHistoryPanel />
      ) : (
        <>
          {/* update 卡永远置顶、不受栈容量折叠；显示时机由其自身状态机 + 闸门决定 */}
          <UpdateNotification />
          <NotificationToastStack />
        </>
      )}
    </div>
  );
}

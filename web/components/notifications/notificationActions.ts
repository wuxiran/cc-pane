// 通知卡片/历史行共用的定位与跳转动作。
// 会话定位（布局名 + 窗格序号）来自 panesStore 反查；查不到时返回 null，UI 省略定位段。
import type { TFunction } from "i18next";
import { focusTab } from "@/hooks/useFocusTab";
import { collectPanels } from "@/lib/paneTree";
import { useActivityBarStore, useOrchestratorStore, usePanesStore } from "@/stores";
import { asTabId } from "@/types/ids";

export interface NotificationSessionLocation {
  layoutName: string;
  paneIndex: number;
}

export function locateNotificationSession(
  sessionId: string | undefined,
): NotificationSessionLocation | null {
  if (!sessionId) return null;
  const location = usePanesStore.getState().findTabBySessionAcrossLayouts(sessionId);
  if (!location) return null;
  const panels = collectPanels(location.tree);
  const paneIndex = panels.findIndex((panel) => panel.id === location.panel.id);
  return {
    layoutName: location.layoutName,
    paneIndex: paneIndex >= 0 ? paneIndex + 1 : 1,
  };
}

/** 与 OrchestratorTaskCard.focusSessionTab 同款：找到 tab 即聚焦并切回分屏视图。 */
export function focusNotificationSession(sessionId: string): boolean {
  const location = usePanesStore.getState().findTabBySessionAcrossLayouts(sessionId);
  if (!location) return false;
  return focusTab(asTabId(location.tab.id), { switchAppView: true });
}

export function jumpToNotificationTask(taskBindingId: string): void {
  useOrchestratorStore.getState().setSelectedTaskId(taskBindingId);
  useActivityBarStore.getState().openOrchestrationOverlay();
}

export function formatRelativeTime(timestamp: number, t: TFunction<"notifications">): string {
  const diffMs = Date.now() - timestamp;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return t("center.timeJustNow", { defaultValue: "刚刚" });
  if (mins < 60) return t("center.timeMinutesAgo", { count: mins, defaultValue: `${mins} 分钟前` });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("center.timeHoursAgo", { count: hours, defaultValue: `${hours} 小时前` });
  const days = Math.floor(hours / 24);
  return t("center.timeDaysAgo", { count: days, defaultValue: `${days} 天前` });
}

const KIND_TITLE_KEYS = new Set([
  "session_exited",
  "waiting_input",
  "turn_end",
  "error",
  "slow_tool",
]);

/** 内置 kind 用本地化标题（后端 title 是英文硬编码）；任意 MCP kind 用其自带 title。 */
export function displayTitle(
  kind: string,
  title: string,
  t: TFunction<"notifications">,
): string {
  if (KIND_TITLE_KEYS.has(kind)) {
    return t(`center.kindTitle.${kind}` as never, { defaultValue: title });
  }
  return title;
}

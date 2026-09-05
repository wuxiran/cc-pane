// 窄档（< lg，即 <1024px）侧栏浮出层（flyout）的持久化与判定逻辑。
// 与 sidebarWidth.ts 同一模式：纯函数 + localStorage 容错，UI 组件只负责接线。
// 宽档（lg/xl）侧栏显隐仍由 useActivityBarStore.sidebarVisible 持有；
// 窄档的展开偏好单独存本 key，两个档位的偏好互不覆盖。
import { isBelow } from "@/lib/breakpoints";

export const SIDEBAR_FLYOUT_STORAGE_KEY = "cc-panes-sidebar-flyout-open";

/** 侧栏是否处于浮出（overlay）档位：宽度不足 lg 时侧栏不再常驻挤占主区。 */
export function isSidebarFlyoutWidth(width: number): boolean {
  return isBelow(width, "lg");
}

/** 浮出层最大宽度占视口比例（窄窗下侧栏不得盖住整个主区）。 */
export const SIDEBAR_FLYOUT_MAX_VW = 85;

export function loadSidebarFlyoutOpen(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_FLYOUT_STORAGE_KEY) === "1";
  } catch {
    // Storage can be unavailable in restricted webviews.
    return false;
  }
}

export function saveSidebarFlyoutOpen(open: boolean) {
  try {
    localStorage.setItem(SIDEBAR_FLYOUT_STORAGE_KEY, open ? "1" : "0");
  } catch {
    // Resizing still works for the current session when persistence is unavailable.
  }
}

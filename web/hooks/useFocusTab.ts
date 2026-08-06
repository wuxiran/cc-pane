// 「聚焦某个 tab」的公共实现。此前同一段逻辑在 SessionsView / HomeActiveSessions /
// MiniView / LayoutTopBar 等 4+ 处复制粘贴（docs/78 §0 提到的重复之一），此处收敛；
// 本次先接新调用方 + SessionsView，其余标记后续迁移。
import { usePanesStore } from "@/stores";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import type { TabId } from "@/types/ids";

interface FocusTabOptions {
  /** 从 Home/资源等非分屏视图跳转时需要切回 panes 视图（默认 true） */
  switchAppView?: boolean;
}

/** 跨布局定位 tab 并聚焦：切布局 → 激活 pane → 选中 tab。非 hook，可在事件回调直接调用。 */
export function focusTab(tabId: TabId, options: FocusTabOptions = {}): boolean {
  const { switchAppView = true } = options;
  const store = usePanesStore.getState();
  const location = store.findTabAcrossLayouts(tabId);
  if (!location) return false;
  if (switchAppView) {
    useActivityBarStore.getState().setAppViewMode("panes");
  }
  if (location.layoutId !== store.currentLayoutId) {
    store.switchLayout(location.layoutId);
  }
  store.setActivePane(location.panel.id);
  store.selectTab(location.panel.id, location.tab.id);
  return true;
}

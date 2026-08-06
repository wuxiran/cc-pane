// Panel 的可见性上报（docs/78）——primary 视图的唯一写侧。
//
// 为什么上报点在 Panel 而不是各内容组件：**后台标签也必须有记录**。
// 五种 contentType（editor/file-explorer/mcp-config/skill-manager/memory-manager）
// 根本收不到可见性 props，若等组件自报，它们永远不会出现在 store 里；而降档
// 判据是「任一视图可见」，缺记录与「全部隐藏」在聚合上同形，会误判成可休眠。
import { useEffect, useRef } from "react";
import { useTabViewStateStore, type ViewVisibility } from "@/stores/useTabViewStateStore";
import type { Panel } from "@/types";

/**
 * 单个 tab 在 primary 视图下的可见性档位：
 * - active  = layoutVisible && 是当前标签 && 是焦点 pane
 * - visible = layoutVisible && 是当前标签
 * - hidden  = 其余（含「布局不可见」——layout 语义在这里编码进 hidden，
 *   所以读侧的渲染判定只看单视图即可；「为什么不可见」由独立的
 *   layoutActive prop 另行承载，供延迟恢复语义用）
 */
export function paneTabVisibility(
  tabId: string,
  activeTabId: string | undefined,
  layoutVisible: boolean,
  isActivePane: boolean,
): ViewVisibility {
  if (!layoutVisible || tabId !== activeTabId) return "hidden";
  return isActivePane ? "active" : "visible";
}

/**
 * 把本 pane 全部 tab 的可见性写进单源 store。
 *
 * 退场：pane 卸载时逐个 removeView（幂等，React19 dev 双挂载安全）。
 * tab 被真正销毁时的清理走 removeTabsInternal → removeOwner，不在这里。
 */
export function useReportPaneVisibility(
  pane: Panel,
  layoutVisible: boolean,
  isActivePane: boolean,
): void {
  const tabIds = pane.tabs.map((t) => t.id).join(",");
  const activeTabId = pane.activeTabId;

  // 上报：依赖变化即重算（store 内写前 diff，同值不触发订阅者）。
  useEffect(() => {
    const { reportView } = useTabViewStateStore.getState();
    for (const tabId of tabIds ? tabIds.split(",") : []) {
      reportView(tabId, "primary", paneTabVisibility(tabId, activeTabId, layoutVisible, isActivePane));
    }
  }, [tabIds, activeTabId, layoutVisible, isActivePane]);

  // 退场：**只在 pane 真正卸载时**清，且清的是当时在场的 tab。
  // 不能把 removeView 挂进上面那个 effect 的 cleanup——依赖每变一次
  // （切标签、切布局）都会先移除再重加，制造一串假的「视图消失」边沿，
  // 降档计时会被反复启停。
  const latestTabIdsRef = useRef(tabIds);
  latestTabIdsRef.current = tabIds;
  useEffect(() => {
    return () => {
      const { removeView } = useTabViewStateStore.getState();
      const ids = latestTabIdsRef.current;
      for (const tabId of ids ? ids.split(",") : []) removeView(tabId, "primary");
    };
  }, []);
}

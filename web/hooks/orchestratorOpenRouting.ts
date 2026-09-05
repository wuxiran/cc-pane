// MCP 打开类事件（open_file / open_browser_tab）的布局路由。
//
// 从 useOrchestratorListener.ts 拆出：该文件已触到行数棘轮上限
// （web/test/lineRatchet.test.ts）。这一组的共同点是「把调用方身份换算成落点，
// 以及落点不在眼前时怎么告诉用户」，与事件订阅本身无关，自成一层。
import { toastInfo } from "@/lib/feedback";

import i18n from "@/i18n";
import { useActivityBarStore, usePanesStore } from "@/stores";

/**
 * 「谁指挥的，就开到谁那儿」——把 MCP 调用方会话解析成它所在的布局/窗格。
 *
 * 不这么做的话，open_file / open_browser_tab 一律落在**用户此刻正看着的布局**：
 * 另一个布局里的 agent 打开页面，标签会飞到用户眼前的布局里（用户报的「到处飞」）。
 * 解析不出（无调用方身份 / 会话已关）返回 null → 保持旧行为落当前布局。
 */
export function resolveCallerPlacement(
  callerSessionId?: string,
): { layoutId: string; paneId: string } | null {
  const sessionId = callerSessionId?.trim();
  if (!sessionId) return null;
  const location = usePanesStore.getState().findTabBySessionAcrossLayouts(sessionId);
  if (!location) return null;
  return { layoutId: location.layoutId, paneId: location.panel.id };
}

/**
 * 浏览器标签落点：显式 paneId（连同它所在布局）> 调用方所在布局/窗格 > 当前布局。
 * `landedLayoutId` 是实际落点，调用方据此决定要不要切视图 / 提示。
 */
export function resolveBrowserPlacement(payload: {
  paneId?: string;
  callerSessionId?: string;
}): { layoutId?: string; paneId?: string; landedLayoutId: string } {
  const panes = usePanesStore.getState();
  const explicitPaneId = payload.paneId?.trim() || undefined;
  const explicitPane = explicitPaneId ? panes.findPaneAcrossLayouts(explicitPaneId) : null;
  const caller = resolveCallerPlacement(payload.callerSessionId);
  const layoutId = explicitPane?.layoutId ?? caller?.layoutId;
  return {
    layoutId,
    paneId: explicitPaneId ?? caller?.paneId,
    landedLayoutId: layoutId ?? panes.currentLayoutId,
  };
}

/**
 * 落点不在用户眼前时给一条可点的提示。
 * 不自动切布局：把用户从正在看的画面拽走比让他自己点一下更糟。
 */
export function notifyOpenedInOtherLayout(
  landedLayoutId: string | null,
  title: string,
): void {
  if (!landedLayoutId) return;
  const store = usePanesStore.getState();
  if (landedLayoutId === store.currentLayoutId) return;
  const layout = store.listLayouts().find((item) => item.id === landedLayoutId);
  if (!layout) return;
  toastInfo(i18n.t("orchestratorOpenedInLayout", { ns: "panes", title, layout: layout.name }), {
    action: {
      label: i18n.t("orchestratorLaunchedInLayoutGoto", { ns: "panes" }),
      onClick: () => {
        usePanesStore.getState().switchLayout(landedLayoutId);
        useActivityBarStore.getState().setAppViewMode("panes");
      },
    },
  });
}

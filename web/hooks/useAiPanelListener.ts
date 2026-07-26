import { useEffect } from "react";
import { aiPanelService } from "@/services/aiPanelService";
import { useAiPanelStore } from "@/stores/useAiPanelStore";
import { useDialogStore } from "@/stores/useDialogStore";
import { useModulePrefsStore } from "@/stores/useModulePrefsStore";
import { useRightDockStore } from "@/stores/useRightDockStore";
import type { AiPanelChangedEvent, AiPanelDelivery, AiPanelDisplay } from "@/types/aiPanel";
import type { ModulePreference } from "@/stores/useModulePrefsStore";

/**
 * 决定一次面板推送到底怎么展示。纯函数，不碰 store，便于穷举测试。
 *
 * - 模块被禁用 → 面板数据仍保存，但没有任何入口
 * - 显式 dialog/dock → 可盖过 autoOpen，但受「允许 AI 请求弹出面板」总闸约束
 * - auto（含缺省）→ 沿用用户偏好：autoOpen 关就只标未读
 */
export function decideAiPanelDelivery(
  display: AiPanelDisplay,
  preference: ModulePreference,
): AiPanelDelivery {
  if (!preference.enabled) return "disabled";
  if (display === "silent") return "unread";
  if (display === "dialog" || display === "dock") {
    if (preference.allowAiDialog === false) return "unread";
    return display;
  }
  if (!preference.autoOpen) return "unread";
  return preference.position === "rightDock" ? "dock" : "dialog";
}

/**
 * 拉一次历史列表。面板的增删改都会改变历史，所以每次变更后都刷新。
 * 失败静默：历史只是浏览入口，拉不到不该影响当前面板的展示。
 */
export function refreshAiPanelHistory(): void {
  const store = useAiPanelStore.getState();
  store.setHistoryLoading(true);
  void aiPanelService
    .listHistory()
    .then((history) => useAiPanelStore.getState().setHistory(history))
    .catch(() => {})
    .finally(() => useAiPanelStore.getState().setHistoryLoading(false));
}

export function applyAiPanelChange(change: AiPanelChangedEvent): void {
  if (change.operation === "close") {
    // close 只是离开活跃集，内容仍留在历史里，所以刷新历史而不是丢弃它
    useAiPanelStore.getState().remove(change.panelId);
    refreshAiPanelHistory();
    if (useAiPanelStore.getState().panels.length === 0) {
      // 弹框是模态的，留一个空壳在屏幕中央很打扰，直接关掉；
      // 右侧 Dock 是常驻面板，退回历史列表即可，不该把用户踢去 git 视图。
      useDialogStore.getState().closeAiPanel();
      if (useRightDockStore.getState().activeView === "aiPanel") {
        useAiPanelStore.getState().setView("list");
      }
    }
    return;
  }
  if (!change.panel || change.panel.panelId !== change.panelId) return;

  const panelState = useAiPanelStore.getState();
  const rightDock = useRightDockStore.getState();
  const dialog = useDialogStore.getState();
  const viewingPanel = panelState.activePanelId === change.panelId && (
    dialog.aiPanelOpen
    || (rightDock.visible && rightDock.activeView === "aiPanel")
  );
  panelState.receive(change.panel, !viewingPanel);

  const preference = useModulePrefsStore.getState().preferences.aiPanel;
  const delivery = decideAiPanelDelivery(change.display ?? "auto", preference);

  if (delivery === "dock") {
    useRightDockStore.setState({ visible: true, activeView: "aiPanel" });
    useAiPanelStore.getState().selectPanel(change.panelId);
  } else if (delivery === "dialog") {
    useDialogStore.getState().openAiPanel();
    useAiPanelStore.getState().selectPanel(change.panelId);
  }

  if (change.deliveryId) {
    void aiPanelService.ackDelivery(change.deliveryId, delivery).catch(() => {
      // 回执失败只影响调用方的判断精度，不该中断面板展示；后端 1.5s 超时会降级为 unknown。
    });
  }

  refreshAiPanelHistory();
}

export function useAiPanelListener(): void {
  useEffect(() => {
    let cancelled = false;
    let ready = false;
    let unlisten: (() => void) | undefined;
    const pending: AiPanelChangedEvent[] = [];

    void (async () => {
      unlisten = await aiPanelService.listen((change) => {
        if (ready) applyAiPanelChange(change);
        else pending.push(change);
      });
      if (cancelled) {
        unlisten();
        return;
      }

      const panels = await aiPanelService.list();
      if (cancelled) return;
      useAiPanelStore.getState().hydrate(panels);
      refreshAiPanelHistory();
      pending.forEach(applyAiPanelChange);
      ready = true;
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}

// 灵动岛点一行 → 主窗口定位到该会话。主窗口已由后端 island_activate_session 唤到前台，
// 这里只负责 pane/tab：终端会话复用通知卡片的定位（含弹出窗口 / 快捷终端回退），
// Agent Chat 先找窗格标签（chatId = tabId），找不到再看右侧面板对话。
import { focusTab } from "@/hooks/useFocusTab";
import { focusNotificationSession } from "@/components/notifications/notificationActions";
import { isDockChatId, useDockChatStore } from "@/stores/useDockChatStore";
import { useRightDockStore } from "@/stores/useRightDockStore";
import { asTabId } from "@/types/ids";
import type { IslandNavigateTarget } from "@/types/island";

export async function navigateToIslandTarget(target: IslandNavigateTarget): Promise<boolean> {
  if (target.kind === "terminal") return focusNotificationSession(target.id);
  if (focusTab(asTabId(target.id), { switchAppView: true })) return true;
  if (!isDockChatId(target.id)) return false;
  const dock = useDockChatStore.getState();
  if (!dock.chats.some((chat) => chat.id === target.id)) return false;
  dock.select(target.id);
  const rightDock = useRightDockStore.getState();
  rightDock.setVisible(true);
  rightDock.setActiveView("chat");
  return true;
}

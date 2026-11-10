import { beforeEach, describe, expect, it, vi } from "vitest";
import { focusTab } from "@/hooks/useFocusTab";
import { focusNotificationSession } from "@/components/notifications/notificationActions";
import { useDockChatStore } from "@/stores/useDockChatStore";
import { useRightDockStore } from "@/stores/useRightDockStore";
import { navigateToIslandTarget } from "./islandNavigation";

vi.mock("@/hooks/useFocusTab", () => ({ focusTab: vi.fn() }));
vi.mock("@/components/notifications/notificationActions", () => ({ focusNotificationSession: vi.fn() }));

describe("navigateToIslandTarget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDockChatStore.setState({ chats: [], activeId: null });
    useRightDockStore.setState({ visible: false, activeView: "git" });
  });

  it("routes terminal rows through the notification focus path (pop-out / quick terminal aware)", async () => {
    vi.mocked(focusNotificationSession).mockResolvedValue(true);
    await expect(navigateToIslandTarget({ kind: "terminal", id: "pty-1" })).resolves.toBe(true);
    expect(focusNotificationSession).toHaveBeenCalledWith("pty-1");
    expect(focusTab).not.toHaveBeenCalled();
  });

  it("focuses the agent-chat tab whose id is the chat id", async () => {
    vi.mocked(focusTab).mockReturnValue(true);
    await expect(navigateToIslandTarget({ kind: "chat", id: "tab-chat" })).resolves.toBe(true);
    expect(focusTab).toHaveBeenCalledWith("tab-chat", { switchAppView: true });
  });

  it("falls back to the right-dock chat when the chat is not a pane tab", async () => {
    vi.mocked(focusTab).mockReturnValue(false);
    useDockChatStore.setState({ chats: [{ id: "dock-chat-1", title: "t", cwd: null, lastViewedAt: 0 }], activeId: null });
    await expect(navigateToIslandTarget({ kind: "chat", id: "dock-chat-1" })).resolves.toBe(true);
    expect(useDockChatStore.getState().activeId).toBe("dock-chat-1");
    expect(useRightDockStore.getState()).toMatchObject({ visible: true, activeView: "chat" });
  });

  it("reports failure for a chat that no longer exists anywhere", async () => {
    vi.mocked(focusTab).mockReturnValue(false);
    await expect(navigateToIslandTarget({ kind: "chat", id: "dock-chat-gone" })).resolves.toBe(false);
  });
});

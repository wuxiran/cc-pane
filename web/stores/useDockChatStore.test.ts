import { beforeEach, describe, expect, it, vi } from "vitest";

const stop = vi.fn((_id: string) => Promise.resolve());
vi.mock("@/services/agentChatService", () => ({ agentChatService: { stop: (id: string) => stop(id) } }));
vi.mock("@/services/runtime", () => ({ isTauriRuntime: () => true }));

import { takePendingResume } from "@/components/agentchat/pendingResume";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import {
  DOCK_CHAT_STORAGE_KEY,
  MAX_DOCK_CHATS,
  isDockChatId,
  useDockChatStore,
} from "./useDockChatStore";

const historyEntry = { acpSessionId: "acp-1", engineId: "codex", cwd: "/repo", title: "旧对话", createdAt: 1, updatedAt: 2 };

describe("useDockChatStore", () => {
  beforeEach(() => {
    localStorage.clear();
    stop.mockClear();
    useDockChatStore.setState({ chats: [], activeId: null, historyOpen: false, historyTab: "chat" });
    useAgentChatStore.setState({ chats: {} });
  });

  it("新对话用独立前缀的 id 并切到前面", () => {
    const id = useDockChatStore.getState().newChat("/repo");

    expect(isDockChatId(id)).toBe(true);
    expect(useDockChatStore.getState()).toMatchObject({ activeId: id, chats: [{ id, cwd: "/repo", title: "" }] });
  });

  it("超出上限时停掉最久没看的那个，当前这条保留", () => {
    const store = useDockChatStore.getState();
    const first = store.newChat("/a");
    for (let index = 1; index < MAX_DOCK_CHATS; index += 1) store.newChat(`/r${index}`);
    useDockChatStore.getState().select(first);

    const latest = useDockChatStore.getState().newChat("/new");

    const ids = useDockChatStore.getState().chats.map((chat) => chat.id);
    expect(ids).toHaveLength(MAX_DOCK_CHATS);
    expect(ids).toContain(first);
    expect(ids).toContain(latest);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(ids).not.toContain(stop.mock.calls[0][0]);
  });

  it("关闭会停后端会话并把焦点交给相邻对话", () => {
    const a = useDockChatStore.getState().newChat(null);
    const b = useDockChatStore.getState().newChat(null);

    useDockChatStore.getState().close(b);

    expect(stop).toHaveBeenCalledWith(b);
    expect(useDockChatStore.getState().activeId).toBe(a);
  });

  it("移到窗格只摘掉条目，不停会话", () => {
    const a = useDockChatStore.getState().newChat(null);

    useDockChatStore.getState().detach(a);

    expect(stop).not.toHaveBeenCalled();
    expect(useDockChatStore.getState().chats).toEqual([]);
  });

  it("续接历史对话登记续接意图；同一会话已在面板里时只切过去", () => {
    const id = useDockChatStore.getState().resume(historyEntry);

    expect(takePendingResume(id)).toEqual({ engineId: "codex", cwd: "/repo", acpSessionId: "acp-1" });
    expect(useDockChatStore.getState().chats[0]).toMatchObject({ title: "旧对话", acpSessionId: "acp-1" });

    useDockChatStore.getState().newChat(null);
    expect(useDockChatStore.getState().resume(historyEntry)).toBe(id);
    expect(useDockChatStore.getState().chats).toHaveLength(2);
    expect(useDockChatStore.getState().activeId).toBe(id);
  });

  it("重启后给开过聊的对话登记续接，没开聊的不登记", async () => {
    localStorage.setItem(DOCK_CHAT_STORAGE_KEY, JSON.stringify({
      state: {
        chats: [
          { id: "dock-chat-1", title: "t", cwd: "/repo", engineId: "claude", acpSessionId: "s-1", lastViewedAt: 1 },
          { id: "dock-chat-2", title: "", cwd: "/repo", lastViewedAt: 2 },
          { id: "not-a-dock-chat", title: "", cwd: "/repo", lastViewedAt: 3 },
        ],
        activeId: "dock-chat-2",
      },
      version: 0,
    }));

    await useDockChatStore.persist.rehydrate();

    expect(useDockChatStore.getState().chats.map((chat) => chat.id)).toEqual(["dock-chat-1", "dock-chat-2"]);
    expect(useDockChatStore.getState().activeId).toBe("dock-chat-2");
    expect(takePendingResume("dock-chat-1")).toEqual({ engineId: "claude", cwd: "/repo", acpSessionId: "s-1" });
    expect(takePendingResume("dock-chat-2")).toBeNull();
  });

  it("syncSession 只在字段真有变化时才写", () => {
    const id = useDockChatStore.getState().newChat(null);
    useDockChatStore.getState().syncSession(id, { engineId: "codex", acpSessionId: "s", title: "第一句" });
    const before = useDockChatStore.getState().chats;

    useDockChatStore.getState().syncSession(id, { engineId: "codex", acpSessionId: "s" });

    expect(useDockChatStore.getState().chats).toBe(before);
    expect(before[0]).toMatchObject({ engineId: "codex", acpSessionId: "s", title: "第一句" });
  });
});

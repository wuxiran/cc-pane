import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const start = vi.fn();
vi.mock("@/services/botService", () => ({ botService: { start: (...args: unknown[]) => start(...args) } }));
vi.mock("@/stores/agentChatEvents", () => ({ ensureAgentChatListener: vi.fn() }));

import { useBotChatBootstrap } from "./useBotChatBootstrap";
import { useAgentChatStore } from "@/stores/useAgentChatStore";

const CHAT = "bot-b1";
const snapshot = { chatId: CHAT, engineId: "claude", phase: "ready", acpSessionId: "s1", autoApproveKinds: [] };

afterEach(() => {
  // 先卸载 hook，再清 store——否则清 store 会让上一个用例的 hook 再拉一次。
  cleanup();
  start.mockReset();
  useAgentChatStore.getState().dropChat(CHAT);
});

describe("useBotChatBootstrap", () => {
  it("does nothing for ordinary chat tabs", () => {
    renderHook(() => useBotChatBootstrap("tab-1", null));
    expect(start).not.toHaveBeenCalled();
  });

  it("starts the bot once and stores the snapshot", async () => {
    start.mockResolvedValue(snapshot);
    const { rerender } = renderHook(() => useBotChatBootstrap(CHAT, "b1"));
    rerender();
    await waitFor(() => expect(useAgentChatStore.getState().chats[CHAT]?.snapshot?.acpSessionId).toBe("s1"));
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith("b1");
  });

  it("restarts with a fresh thread after the chat state is dropped", async () => {
    start.mockResolvedValue(snapshot);
    renderHook(() => useBotChatBootstrap(CHAT, "b1"));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useAgentChatStore.getState().chats[CHAT]?.snapshot).toBeTruthy());
    act(() => useAgentChatStore.getState().dropChat(CHAT));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
  });

  it("surfaces start errors", async () => {
    start.mockRejectedValue(new Error("engine missing"));
    const { result } = renderHook(() => useBotChatBootstrap(CHAT, "b1"));
    await waitFor(() => expect(result.current.error).toBe("engine missing"));
    expect(result.current.starting).toBe(false);
  });
});

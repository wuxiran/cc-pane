import "@/i18n";
import { useRef, useState } from "react";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { takePendingDraft, usePendingDraft } from "@/components/agentchat/pendingDraft";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { useDockChatStore } from "@/stores/useDockChatStore";
import { useRightDockStore } from "@/stores/useRightDockStore";
import { askDockChatToReview, dockChatReviewPrompt } from "./dockChatReview";

function DraftProbe({ chatId }: { chatId: string }) {
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLTextAreaElement | null>(null);
  usePendingDraft(chatId, setDraft, ref);
  return <textarea ref={ref} data-testid="probe" value={draft} readOnly />;
}

beforeEach(() => {
  localStorage.clear();
  useDockChatStore.setState({ chats: [], activeId: null, historyOpen: false, historyTab: "chat" });
  useAgentChatStore.setState({ chats: {} });
  useRightDockStore.setState({ visible: true, activeView: "git" });
});

describe("askDockChatToReview", () => {
  it("新开一个以该项目为目录的对话，切到对话视图并预填审阅 prompt（不发送）", () => {
    const chatId = askDockChatToReview("/repo/alpha", "Alpha");
    const dock = useDockChatStore.getState();
    expect(dock.activeId).toBe(chatId);
    expect(dock.chats.find((chat) => chat.id === chatId)?.cwd).toBe("/repo/alpha");
    expect(useRightDockStore.getState()).toMatchObject({ visible: true, activeView: "chat" });
    const prompt = takePendingDraft(chatId);
    expect(prompt).toBe(dockChatReviewPrompt("Alpha"));
    expect(prompt).toContain("Alpha");
    expect(prompt).toMatch(/git diff/);
    expect(useAgentChatStore.getState().chats[chatId]?.pendingPrompt ?? null).toBeNull();
  });

  it("当前对话还停在启动页就复用它（改到该项目目录），不堆空对话", () => {
    const existing = useDockChatStore.getState().newChat("/repo/other");
    const chatId = askDockChatToReview("/repo/alpha", "Alpha");
    expect(chatId).toBe(existing);
    expect(useDockChatStore.getState().chats).toHaveLength(1);
    expect(useAgentChatStore.getState().chats[existing]?.cwdOverride).toBe("/repo/alpha");
  });

  it("当前对话已开聊就另开，不打断它", () => {
    const busy = useDockChatStore.getState().newChat("/repo/alpha");
    useAgentChatStore.getState().pushNotice(busy, "hello");
    const chatId = askDockChatToReview("/repo/alpha", "Alpha");
    expect(chatId).not.toBe(busy);
    expect(useDockChatStore.getState().chats).toHaveLength(2);
  });

  it("启动页已挂着时也能收到预填（订阅投递）", () => {
    const chatId = useDockChatStore.getState().newChat("/repo/alpha");
    render(<DraftProbe chatId={chatId} />);
    expect(screen.getByTestId("probe")).toHaveValue("");
    act(() => {
      askDockChatToReview("/repo/alpha", "Alpha");
    });
    expect(screen.getByTestId("probe")).toHaveValue(dockChatReviewPrompt("Alpha"));
    expect(takePendingDraft(chatId)).toBeNull();
  });
});

import "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMemo, useRef, useState } from "react";
import { useChatTimelineStore } from "@/stores/useChatTimelineStore";
import type { AgentChatItem } from "@/types/agentChat";
import ChatTimelineNavigation from "./ChatTimelineNavigation";
import { groupChatItems } from "./chatTurns";

const onNavigate = vi.fn();
function Harness({ count = 3, conversation = "one", revision = "" }: { count?: number; conversation?: string; revision?: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(2);
  const turns = useMemo(() => groupChatItems(Array.from({ length: count }, (_, index): AgentChatItem => ({
    type: "user", id: `${revision}u${index}`, at: index + 1, text: `Question ${index + 1}`,
  }))), [count, revision]);
  return <div>
    <ChatTimelineNavigation conversationKey={conversation} turns={turns} scrollRef={scrollRef}
      visibleCount={visible} onReveal={(index) => setVisible(Math.max(visible, turns.length - index))} onNavigate={onNavigate} />
    <div ref={scrollRef} data-testid="scroll">
      <div>{turns.slice(-visible).map((turn, index) => <div key={turn.id} data-chat-turn-id={turn.id}
        data-chat-turn-index={Math.max(0, turns.length - visible) + index} data-testid={`turn-${turn.id}`}>{turn.id}</div>)}</div>
    </div>
  </div>;
}

beforeEach(() => { useChatTimelineStore.setState({ bookmarks: {} }); vi.clearAllMocks(); });

describe("chat timeline navigation", () => {
  it("previews on keyboard focus and saves a bookmark without jumping", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const entry = screen.getByRole("button", { name: /Question 1/ });
    act(() => entry.focus());
    expect(await screen.findByRole("dialog", { name: /1.*预览/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "添加书签" }));
    expect(screen.getByRole("button", { name: "移除书签" })).toHaveAttribute("aria-pressed", "true");
    expect(onNavigate).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(entry).toHaveFocus();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("reveals an old paginated turn before jumping and leaves follow-latest mode", async () => {
    const user = userEvent.setup();
    render(<Harness count={70} />);
    expect(screen.queryByTestId("turn-u0")).toBeNull();
    await user.click(screen.getByRole("button", { name: /第 1 轮/ }));
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(screen.getByTestId("turn-u0")).toBeInTheDocument();
  });
  it("supports arrow and end keys, and highlights the turn at the viewport anchor", async () => {
    const user = userEvent.setup();
    render(<Harness count={3} />);
    const entry = screen.getByRole("button", { name: /第 1 轮/ });
    act(() => entry.focus());
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: /第 2 轮/ })).toHaveFocus();
    expect(await screen.findByRole("dialog", { name: "第 2 轮预览" })).toBeInTheDocument();
    await user.keyboard("{End}");
    expect(screen.getByRole("button", { name: /第 3 轮/ })).toHaveFocus();
    expect(await screen.findByRole("dialog", { name: "第 3 轮预览" })).toBeInTheDocument();
    const root = screen.getByTestId("scroll");
    Object.defineProperties(root, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } });
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({ top: 0 } as DOMRect);
    vi.spyOn(screen.getByTestId("turn-u1"), "getBoundingClientRect").mockReturnValue({ top: 0 } as DOMRect);
    vi.spyOn(screen.getByTestId("turn-u2"), "getBoundingClientRect").mockReturnValue({ top: 300 } as DOMRect);
    fireEvent.scroll(root);
    await waitFor(() => expect(screen.getByRole("button", { name: /第 2 轮/ })).toHaveAttribute("aria-current", "step"));
  });
  it("keeps a keyboard entry point after replay replaces the focused marker's local id", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness />);
    act(() => screen.getByRole("button", { name: /第 1 轮/ }).focus());
    rerender(<Harness revision="replay-" />);
    const navigation = screen.getByRole("navigation");
    await waitFor(() => expect(navigation.querySelectorAll("[data-timeline-entry][tabindex='0']")).toHaveLength(1));
    await user.tab();
    expect(navigation).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard("{Home}");
    expect(screen.getByRole("button", { name: /第 1 轮/ })).toHaveFocus();
    expect(await screen.findByRole("dialog", { name: "第 1 轮预览" })).toBeInTheDocument();
  });
});

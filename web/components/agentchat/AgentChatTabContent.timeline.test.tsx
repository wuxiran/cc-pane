import "@/i18n";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { Tab } from "@/types";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import AgentChatTabContent from "./AgentChatTabContent";

vi.mock("@/stores/agentChatEvents", () => ({ ensureAgentChatListener: vi.fn() }));
vi.mock("./ChatSessionHeader", () => ({ default: () => null }));
vi.mock("./ChatComposer", () => ({ default: () => null }));
vi.mock("./EnginePicker", () => ({ default: () => null }));
vi.mock("./ChatWelcome", () => ({ default: () => null }));
vi.mock("./ChatTurnView", () => ({ default: ({ turn }: { turn: { id: string } }) => <p data-testid={`rendered-${turn.id}`}>{turn.id}</p> }));

beforeEach(() => {
  useAgentChatStore.setState({ chats: {} });
  useAgentChatStore.getState().setSnapshot("timeline-chat", {
    chatId: "timeline-chat", engineId: "codex", acpSessionId: "session", phase: "ready",
  });
  for (let index = 1; index <= 70; index++) {
    useAgentChatStore.getState().addUserMessage("timeline-chat", `Prompt ${index}`);
    useAgentChatStore.getState().appendStreamText("timeline-chat", "assistant", `Answer ${index}`);
  }
});

it("reveals real paginated turns and does not jump to the bottom when a reply streams", async () => {
  const user = userEvent.setup();
  const firstId = useAgentChatStore.getState().chats["timeline-chat"].items[0].id;
  const { container } = render(<AgentChatTabContent tab={{ id: "timeline-chat", contentType: "agent-chat", projectPath: "/fixture" } as Tab} />);
  expect(screen.queryByTestId(`rendered-${firstId}`)).toBeNull();
  await user.click(screen.getByRole("button", { name: "跳转到第 1 轮：Prompt 1" }));
  await waitFor(() => expect(screen.getByTestId(`rendered-${firstId}`)).toBeInTheDocument());
  const scroller = container.querySelector(".overflow-y-auto[data-testid]") ?? container.querySelector("div.h-full.overflow-y-auto");
  if (!(scroller instanceof HTMLElement)) throw new Error("missing chat scroller");
  Object.defineProperties(scroller, { scrollHeight: { configurable: true, value: 5000 }, clientHeight: { configurable: true, value: 500 } });
  scroller.scrollTop = 100;
  act(() => useAgentChatStore.getState().appendStreamText("timeline-chat", "assistant", " more tokens"));
  expect(scroller.scrollTop).toBe(100);
});

it("keeps a timeline destination rendered when later notices and whole turns arrive", async () => {
  const user = userEvent.setup();
  const store = useAgentChatStore.getState();
  const firstId = store.chats["timeline-chat"].items[0].id;
  const { container } = render(<AgentChatTabContent tab={{ id: "timeline-chat", contentType: "agent-chat", projectPath: "/fixture" } as Tab} />);
  await user.click(screen.getByRole("button", { name: "跳转到第 1 轮：Prompt 1" }));
  await waitFor(() => expect(screen.getByTestId(`rendered-${firstId}`)).toBeInTheDocument());
  const scroller = container.querySelector<HTMLElement>(".agent-chat-scroll")!;
  Object.defineProperties(scroller, { scrollHeight: { configurable: true, value: 5000 }, clientHeight: { configurable: true, value: 500 } });
  scroller.scrollTop = 100;
  act(() => {
    store.pushNotice("timeline-chat", "Agent continued in the background");
    store.appendStreamText("timeline-chat", "assistant", "A separate assistant turn");
    store.addUserMessage("timeline-chat", "Next whole prompt");
  });
  expect(screen.getByTestId(`rendered-${firstId}`)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /显示.*更早|上 \d+ 条消息/ })).toBeNull();
  expect(scroller.scrollTop).toBe(100);
});

import "@/i18n";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { Tab } from "@/types";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import AgentChatTabContent from "./AgentChatTabContent";

vi.mock("@/stores/agentChatEvents", () => ({ ensureAgentChatListener: vi.fn() }));
vi.mock("@/services/agentChatService", () => ({ agentChatService: { get: vi.fn().mockResolvedValue(null) } }));
vi.mock("./EnginePicker", () => ({ default: ({ onHistory, onCheckpoints }: { onHistory: () => void; onCheckpoints: () => void }) =>
  <div><button onClick={onHistory}>history</button><button onClick={onCheckpoints}>checkpoints</button></div> }));
vi.mock("./ChatRunHistoryPanel", () => ({ default: ({ chatId }: { chatId: string }) => <p>saved history for {chatId}</p> }));
vi.mock("./TurnCheckpointPanel", () => ({ default: ({ chatId }: { chatId: string }) => <p>saved checkpoints for {chatId}</p> }));
beforeEach(() => useAgentChatStore.setState({ chats: {} }));

it("makes durable history and checkpoints reachable even without an engine snapshot", async () => {
  const user = userEvent.setup();
  render(<AgentChatTabContent tab={{ id: "offline-chat", contentType: "agent-chat", projectPath: "/fixture" } as Tab} />);
  await user.click(screen.getByRole("button", { name: "history" }));
  expect(await screen.findByText("saved history for offline-chat")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "checkpoints" }));
  expect(await screen.findByText("saved checkpoints for offline-chat")).toBeInTheDocument();
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { BotSummary } from "@/types/bot";

const list = vi.fn();
const openBotChat = vi.fn();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("@/services/botService", () => ({
  botService: {
    list: (...args: unknown[]) => list(...args),
    listenChanged: vi.fn(async () => () => {}),
    newThread: vi.fn(),
    remove: vi.fn(),
    save: vi.fn(),
    start: vi.fn(),
  },
}));
vi.mock("@/stores/agentChatEvents", () => ({
  dropAgentChatState: vi.fn(),
  ensureAgentChatListener: vi.fn(),
}));
vi.mock("./openBotChat", () => ({ openBotChat: (...args: unknown[]) => openBotChat(...args) }));
vi.mock("./BotEditorDialog", () => ({ default: () => null }));

import BotContactsView from "./BotContactsView";
import { ensureAgentChatListener } from "@/stores/agentChatEvents";
import { useAgentChatStore } from "@/stores/useAgentChatStore";

function summary(partial: Partial<BotSummary>): BotSummary {
  return {
    id: "b1",
    name: "周报助手",
    avatar: "📝",
    color: "#6366f1",
    persona: "回答简洁\n第二行",
    engineId: "claude",
    cwd: null,
    autoApproveKinds: [],
    createdAt: 1,
    updatedAt: 1,
    chatId: "bot-b1",
    effectiveCwd: "/data/bots/b1/home",
    ...partial,
  };
}

describe("BotContactsView", () => {
  beforeEach(() => {
    list.mockReset();
    openBotChat.mockReset();
  });

  it("shows the empty state and starts the global chat listener", async () => {
    list.mockResolvedValue([]);
    render(<TooltipProvider><BotContactsView /></TooltipProvider>);
    expect(await screen.findByText("bots.empty")).toBeInTheDocument();
    expect(ensureAgentChatListener).toHaveBeenCalled();
  });

  it("lists bots with their persona's first line and opens one on click", async () => {
    list.mockResolvedValue([summary({})]);
    render(<TooltipProvider><BotContactsView /></TooltipProvider>);
    const name = await screen.findByText("周报助手");
    expect(screen.getByText("回答简洁")).toBeInTheDocument();
    fireEvent.click(name);
    expect(openBotChat).toHaveBeenCalledWith(expect.objectContaining({ id: "b1" }));
  });

  it("shows a busy line while the bot is generating", async () => {
    list.mockResolvedValue([summary({})]);
    useAgentChatStore.getState().setSnapshot("bot-b1", {
      chatId: "bot-b1",
      engineId: "claude",
      phase: "generating",
      autoApproveKinds: [],
    } as never);
    render(<TooltipProvider><BotContactsView /></TooltipProvider>);
    await waitFor(() => expect(screen.getByText("bots.busy")).toBeInTheDocument());
    useAgentChatStore.getState().dropChat("bot-b1");
  });
});

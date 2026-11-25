import "@/i18n";
import { render, screen } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import ChatEngineSwitch from "./ChatEngineSwitch";

vi.mock("@/services/agentChatService", () => ({ agentChatService: { listEngines: vi.fn().mockResolvedValue([]) } }));

const chatId = "engine-switch";
beforeEach(() => useAgentChatStore.getState().dropChat(chatId));

describe("ChatEngineSwitch", () => {
  it("is enabled when ready and disabled while generating or awaiting permission", () => {
    useAgentChatStore.getState().setSnapshot(chatId, { chatId, engineId: "claude", phase: "ready", acpSessionId: "s" });
    render(<ChatEngineSwitch chatId={chatId} cwd="/repo" />);
    const button = screen.getByTestId("chat-engine-switch");
    expect(button).toBeEnabled();
    expect(button.querySelector('[data-cli-brand="claude"]')).not.toBeNull();
    act(() => useAgentChatStore.getState().setSnapshot(chatId, { chatId, engineId: "claude", phase: "generating", acpSessionId: "s" }));
    expect(button).toBeDisabled();
    act(() => {
      useAgentChatStore.getState().setSnapshot(chatId, { chatId, engineId: "claude", phase: "ready", acpSessionId: "s" });
      useAgentChatStore.getState().enqueuePermission(chatId, { requestKey: "k", params: {} });
    });
    expect(button).toBeDisabled();
  });
});

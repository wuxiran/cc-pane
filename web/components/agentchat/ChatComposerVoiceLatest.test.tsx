import "@/i18n";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import ChatComposer from "./ChatComposer";
let voiceText: ((text: string) => void) | null = null;
vi.mock("./ChatVoiceButton", () => ({ default: ({ onText }: { onText: (text: string) => void }) => { voiceText = onText; return <button type="button" aria-label="mock voice" onClick={() => onText("spoken")}>voice</button>; } }));
vi.mock("./useComposerAttachments", () => ({ useComposerAttachments: () => ({
  attachments: [], clearAttachments: vi.fn(), removeAttachment: vi.fn(), dropHint: false,
  hostRef: { current: null }, attachFromDialog: vi.fn(), pushFileAttachment: vi.fn(), attachClipboardFiles: vi.fn(),
}) }));
vi.mock("@/services/runtime", async (original) => ({ ...(await original<object>()), isTauriRuntime: () => true }));
const CHAT = "voice-latest-draft";
beforeEach(() => { voiceText = null; useAgentChatStore.getState().dropChat(CHAT); useAgentChatStore.getState().setSnapshot(CHAT, { chatId: CHAT, engineId: "claude", phase: "ready" }); });
describe("composer voice insertion", () => {
  it("inserts recognition into the latest draft after typing while recording", () => {
    render(<TooltipProvider><ChatComposer chatId={CHAT} cwd="/repo" phase="ready" generating={false} availableCommands={[]} /></TooltipProvider>);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "before" } });
    fireEvent.change(input, { target: { value: "before + typed later" } });
    act(() => voiceText?.("spoken"));
    expect(input).toHaveValue("before + typed later spoken");
  });
});

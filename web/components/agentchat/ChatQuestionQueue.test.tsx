import "@/i18n";
import i18n from "@/i18n";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentChatService } from "@/services/agentChatService";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import ChatQuestionQueue from "./ChatQuestionQueue";
vi.mock("@/services/agentChatService", () => ({ agentChatService: { respondElicitation: vi.fn() } }));
const CHAT = "question-queue-test";
const enqueue = (key: string) => useAgentChatStore.getState().enqueueElicitation(CHAT, { requestKey: key, params: {
  mode: "form", message: `Question ${key}`, requestedSchema: { type: "object", required: ["answer"], properties: { answer: { type: "string", title: `Answer ${key}` } } },
} });
const send = () => screen.getByRole("button", { name: i18n.t("agentChatSend", { ns: "panes" }) });
beforeEach(() => { vi.clearAllMocks(); useAgentChatStore.getState().dropChat(CHAT); });
describe("ChatQuestionQueue", () => {
  it("preserves drafts and in-flight state across tab changes and serializes requests", async () => {
    enqueue("A"); enqueue("B"); let acknowledge!: () => void;
    vi.mocked(agentChatService.respondElicitation).mockImplementation(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
    const view = render(<ChatQuestionQueue chatId={CHAT} />);
    fireEvent.change(screen.getByLabelText("Answer A"), { target: { value: "free text" } });
    view.unmount(); render(<ChatQuestionQueue chatId={CHAT} />);
    expect(screen.getByLabelText("Answer A")).toHaveValue("free text");
    fireEvent.click(send());
    expect(screen.getByLabelText("Answer A")).toBeDisabled();
    expect(agentChatService.respondElicitation).toHaveBeenCalledWith(CHAT, "A", { action: "accept", content: { answer: "free text" } });
    act(() => enqueue("A"));
    expect(useAgentChatStore.getState().chats[CHAT].pendingElicitations).toHaveLength(2);
    await act(async () => acknowledge());
    expect(screen.getByLabelText("Answer B")).toBeEnabled();
  });
  it("retains a failed answer for retry, and ignores late results after cancellation", async () => {
    enqueue("A");
    vi.mocked(agentChatService.respondElicitation).mockRejectedValueOnce({ code: "ACP_WRITE_FAILED", message: "pipe unavailable" });
    render(<ChatQuestionQueue chatId={CHAT} />);
    fireEvent.change(screen.getByLabelText("Answer A"), { target: { value: "retry this" } });
    await act(async () => fireEvent.click(send()));
    expect(screen.getByRole("alert")).toHaveTextContent("pipe unavailable");
    expect(screen.getByLabelText("Answer A")).toHaveValue("retry this");
    let acknowledge!: () => void;
    vi.mocked(agentChatService.respondElicitation).mockImplementation(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
    fireEvent.click(send());
    act(() => useAgentChatStore.getState().turnEnded(CHAT, "end_turn"));
    await act(async () => acknowledge());
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(useAgentChatStore.getState().chats[CHAT].pendingElicitations).toEqual([]);
  });
});

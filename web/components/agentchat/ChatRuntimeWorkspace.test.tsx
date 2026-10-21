import "@/i18n";
import i18n from "i18next";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { agentRuntimeService } from "@/services/agentRuntimeService";
import { turnCheckpointService } from "@/services/turnCheckpointService";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { useAgentChatDraftStore } from "@/stores/useAgentChatDraftStore";
import ChatRuntimeWorkspace, { useChatRuntimeTools } from "./ChatRuntimeWorkspace";

vi.mock("@/services/agentRuntimeService", () => ({ agentRuntimeService: { list: vi.fn(), events: vi.fn() } }));
vi.mock("@/services/turnCheckpointService", () => ({ turnCheckpointService: { list: vi.fn(), review: vi.fn(), restore: vi.fn() } }));

function Entry() {
  const tools = useChatRuntimeTools();
  const draft = useAgentChatDraftStore((state) => state.drafts["resumed-tab"]?.text);
  return <><button onClick={tools?.openHistory}>Open history</button><output>{draft}</output></>;
}

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  vi.clearAllMocks();
  useAgentChatStore.setState({ chats: {} });
  useAgentChatStore.getState().setSnapshot("resumed-tab", {
    chatId: "resumed-tab", engineId: "codex", acpSessionId: "stable-session", phase: "ready",
  });
  useAgentChatDraftStore.setState({ drafts: {
    "resumed-tab": { text: "Keep this unsent draft", attachments: [], sentHistory: ["Earlier prompt"] },
  } });
  vi.mocked(agentRuntimeService.list).mockImplementation(async (query) => ({
    runs: query?.acpSessionId === "stable-session" ? [{
      id: "old-run", chatId: "original-tab", engineId: "codex", acpSessionId: "stable-session", cwd: "/fixture",
      startedAt: 1792627200000, status: "completed", eventCount: 0, checkpointId: "historical-checkpoint",
    }] : [], hasMore: false,
  }));
  vi.mocked(agentRuntimeService.events).mockResolvedValue({ events: [], hasMore: false });
  vi.mocked(turnCheckpointService.list).mockResolvedValue([]);
  vi.mocked(turnCheckpointService.review).mockResolvedValue({
    record: { id: "historical-checkpoint", chatId: "original-tab", turnId: "old-turn", cwd: "/fixture",
      createdAt: "2026-10-22T00:00:00Z", completedAt: "2026-10-22T00:00:01Z", outcome: "completed",
      before: null, after: null, unavailableReason: null, restoredAt: null },
    revision: "reviewed-historical-revision", canRestore: true, blockedReason: null,
    files: [{ path: "historical.txt", status: "modified", binary: false, conflict: false, supported: true,
      beforeContent: "Original historical contents", afterContent: "After historical turn", previewOmitted: false }],
  });
});

it("opens a resumed session's old checkpoint without altering its current draft or restoring files", async () => {
  const draft = useAgentChatDraftStore.getState().drafts["resumed-tab"];
  const user = userEvent.setup();
  render(<ChatRuntimeWorkspace chatId="resumed-tab"><Entry /></ChatRuntimeWorkspace>);
  await user.click(screen.getByRole("button", { name: "Open history" }));
  await user.selectOptions(await screen.findByLabelText("范围"), "session");
  await user.click(screen.getByRole("button", { name: "应用筛选" }));
  await user.click(await screen.findByRole("button", { name: "查看此回合检查点" }));
  expect(await screen.findByText("Original historical contents")).toBeInTheDocument();
  expect(turnCheckpointService.list).toHaveBeenCalledWith("original-tab");
  expect(turnCheckpointService.review).toHaveBeenCalledWith("historical-checkpoint");
  expect(screen.getByRole("combobox")).toHaveValue("historical-checkpoint");
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(turnCheckpointService.restore).not.toHaveBeenCalled();
  expect(useAgentChatDraftStore.getState().drafts["resumed-tab"]).toBe(draft);
  await waitFor(() => expect(useAgentChatStore.getState().chats["resumed-tab"].snapshot?.acpSessionId).toBe("stable-session"));
});

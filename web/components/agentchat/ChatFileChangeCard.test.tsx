import "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { undoAgentFileEdit } from "@/services/agentEditService";
import { computeTextDiff } from "@/services/agentChatService";
import type { AcpToolCall } from "@/types/agentChat";
import ToolCallCard from "./ToolCallCard";
import ToolCallGroup from "./ToolCallGroup";
import { canUndoFileEdit, completedFileEdits } from "./fileEdits";

vi.mock("@/services/agentEditService", () => ({ undoAgentFileEdit: vi.fn() }));
vi.mock("@/services/agentChatService", () => ({ computeTextDiff: vi.fn() }));

const chatId = "edit-card-test";
const call: AcpToolCall = { toolCallId: "edit-one", title: "Apply change", status: "completed", content: [{ type: "diff", path: "/repo/file.ts", oldText: "before", newText: "after" }] };
const undoButton = () => screen.getByRole("button", { name: /^(撤销|Undo)$/ });

beforeEach(() => {
  vi.clearAllMocks();
  useAgentChatStore.getState().dropChat(chatId);
  useAgentChatStore.getState().setSnapshot(chatId, { chatId, engineId: "claude", acpSessionId: "session", phase: "ready" });
  vi.mocked(undoAgentFileEdit).mockResolvedValue();
  vi.mocked(computeTextDiff).mockResolvedValue({ hunks: [], stats: { additions: 1, deletions: 1, changes: 1 }, isBinary: false, truncated: false });
});

describe("file change cards", () => {
  it("shows a successful edit, opens the file and calculates diff only on request", async () => {
    const open = vi.fn();
    render(<ToolCallCard call={call} chatId={chatId} onOpenLocation={open} />);
    expect(screen.getByTestId("chat-file-change")).toBeVisible();
    expect(computeTextDiff).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "/repo/file.ts" }));
    expect(open).toHaveBeenCalledWith("/repo/file.ts");
    fireEvent.click(screen.getByRole("button", { name: /查看变更|View changes/ }));
    await waitFor(() => expect(computeTextDiff).toHaveBeenCalledWith("before", "after"));
  });

  it("sends exact observed identity and contents, then prevents a duplicate undo", async () => {
    render(<ToolCallCard call={call} chatId={chatId} />);
    fireEvent.click(undoButton());
    await waitFor(() => expect(screen.getByRole("button", { name: /已撤销|Undone/ })).toBeDisabled());
    expect(undoAgentFileEdit).toHaveBeenCalledWith(chatId, { acpSessionId: "session", toolCallId: "edit-one", path: "/repo/file.ts", oldText: "before", newText: "after" });
  });

  it("allows guarded undo of an explicitly new file and preserves null in the request", async () => {
    render(<ToolCallCard call={{ ...call, content: [{ type: "diff", path: "/repo/new.ts", oldText: null, newText: "created" }] }} chatId={chatId} />);
    expect(undoButton()).toBeEnabled();
    fireEvent.click(undoButton());
    await waitFor(() => expect(screen.getByRole("button", { name: /已撤销|Undone/ })).toBeDisabled());
    expect(undoAgentFileEdit).toHaveBeenCalledWith(chatId, { acpSessionId: "session", toolCallId: "edit-one", path: "/repo/new.ts", oldText: null, newText: "created" });
  });

  it("does not undo during generation, and preserves an actionable backend conflict", async () => {
    const { rerender } = render(<ToolCallCard call={call} chatId={chatId} />);
    act(() => useAgentChatStore.getState().setSnapshot(chatId, { chatId, engineId: "claude", acpSessionId: "session", phase: "generating" }));
    expect(undoButton()).toBeDisabled();
    act(() => useAgentChatStore.getState().setSnapshot(chatId, { chatId, engineId: "claude", acpSessionId: "session", phase: "ready" }));
    vi.mocked(undoAgentFileEdit).mockRejectedValue({ code: "ACP_EDIT_CHANGED", message: "File changed since review" });
    rerender(<ToolCallCard call={call} chatId={chatId} />);
    fireEvent.click(undoButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("File changed since review");
    expect(undoButton()).toBeEnabled();
  });

  it("does not claim failed or incomplete tool calls edited a file", () => {
    for (const status of ["failed", "pending", "in_progress"] as const) expect(completedFileEdits({ ...call, status })).toEqual([]);
    expect(completedFileEdits({ ...call, content: [{ type: "diff", path: "file" }] })).toEqual([]);
    expect(completedFileEdits({ ...call, content: [{ type: "diff", path: "file", newText: "after" }] })).toEqual([]);
    const created = completedFileEdits({ ...call, content: [{ type: "diff", path: "file", oldText: null, newText: "after" }] });
    expect(canUndoFileEdit(created[0], created)).toBe(true);
    const duplicate = completedFileEdits({ ...call, content: [...call.content!, ...call.content!] });
    expect(canUndoFileEdit(duplicate[0], duplicate)).toBe(false);
  });

  it("does not mark a replacement edit undone when an earlier request finishes", async () => {
    let finish!: () => void;
    vi.mocked(undoAgentFileEdit).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const { rerender } = render(<ToolCallCard call={call} chatId={chatId} />);
    fireEvent.click(undoButton());
    rerender(<ToolCallCard call={{ ...call, content: [{ ...call.content![0], oldText: "after", newText: "newer" }] }} chatId={chatId} />);
    await act(async () => finish());
    expect(undoButton()).toBeEnabled();
    expect(screen.queryByRole("button", { name: /已撤销|Undone/ })).not.toBeInTheDocument();
  });

  it("keeps the file card visible when surrounding completed tools are collapsed", () => {
    render(<ToolCallGroup chatId={chatId} onOpenLocation={vi.fn()} items={[
      { type: "tool_call", id: "a", at: 1, call: { toolCallId: "a", title: "Read A", status: "completed" } },
      { type: "tool_call", id: "b", at: 2, call: { toolCallId: "b", title: "Read B", status: "completed" } },
      { type: "tool_call", id: "c", at: 3, call },
    ]} />);
    expect(screen.getByTestId("chat-file-change")).toBeVisible();
    expect(screen.queryByText("Read A")).not.toBeInTheDocument();
  });
});

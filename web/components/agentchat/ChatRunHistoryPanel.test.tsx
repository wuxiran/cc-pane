import "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpRunEventPage, AcpRunRecord } from "@/types/agentRuntime";
import { agentRuntimeService } from "@/services/agentRuntimeService";
import ChatRunHistoryPanel from "./ChatRunHistoryPanel";

vi.mock("@/services/agentRuntimeService", () => ({ agentRuntimeService: { list: vi.fn(), events: vi.fn() } }));
function run(id: string, overrides: Partial<AcpRunRecord> = {}): AcpRunRecord {
  return { id, chatId: "chat", engineId: "codex", acpSessionId: `session-${id}`, cwd: "/repo",
    startedAt: 1792627200000, status: "interrupted", eventCount: 5, ...overrides };
}
function chunk(seq: number, text: string) {
  return { seq, at: seq, kind: "update", payload: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } };
}
const show = () => render(<ChatRunHistoryPanel chatId="chat" engineId="codex" acpSessionId="stable-session" open onOpenChange={vi.fn()} />);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(agentRuntimeService.list).mockResolvedValue({ runs: [run("r1")], hasMore: false });
  vi.mocked(agentRuntimeService.events).mockResolvedValue({ events: [chunk(1, "Saved "), chunk(2, "answer")], hasMore: false });
});

describe("ChatRunHistoryPanel", () => {
  it("reads merged text and interrupted status without replaying permission or question actions", async () => {
    vi.mocked(agentRuntimeService.events).mockResolvedValue({ events: [chunk(1, "Saved "), chunk(2, "answer"),
      { seq: 3, at: 3, kind: "permission_request", payload: { options: [{ name: "Allow once" }] } },
      { seq: 4, at: 4, kind: "elicitation_request", payload: { message: "Old question" } },
    ], hasMore: false });
    show();
    expect(await screen.findByText("Saved answer")).toBeInTheDocument();
    expect(screen.getByText(/本轮在写入结束记录前中断/)).toBeInTheDocument();
    expect(screen.getByText("permission_request · 历史请求 · 只读")).toBeInTheDocument();
    expect(screen.getByText("elicitation_request · 历史请求 · 只读")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Allow|批准|发送|回答/ })).toBeNull();
    expect(agentRuntimeService.list).toHaveBeenCalledWith({ chatId: "chat", offset: 0 });
  });

  it("shows recording failures as incomplete, separate from the saved run outcome", async () => {
    vi.mocked(agentRuntimeService.list).mockResolvedValue({ runs: [run("r1", { status: "completed", recordingError: "disk full" })], hasMore: false });
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent("记录不完整: disk full");
    expect(screen.getByText(/Agent 已结束/)).toBeInTheDocument();
  });

  it("paginates events by sequence and merges chunks across page boundaries", async () => {
    const user = userEvent.setup();
    vi.mocked(agentRuntimeService.events).mockResolvedValueOnce({ events: [chunk(1, "Page ")], hasMore: true })
      .mockResolvedValueOnce({ events: [chunk(2, "two")], hasMore: false });
    show();
    await user.click(await screen.findByRole("button", { name: "加载更多事件" }));
    expect(await screen.findByText("Page two")).toBeInTheDocument();
    expect(agentRuntimeService.events).toHaveBeenNthCalledWith(2, "r1", 1);
  });

  it("paginates runs without replacing the selection", async () => {
    const user = userEvent.setup();
    vi.mocked(agentRuntimeService.list).mockResolvedValueOnce({ runs: [run("r1")], hasMore: true })
      .mockResolvedValueOnce({ runs: [run("r2", { engineId: "claude" })], hasMore: false });
    show();
    await user.click(await screen.findByRole("button", { name: "加载更多运行" }));
    expect(await screen.findByRole("button", { name: /claude/ })).toBeInTheDocument();
    expect(agentRuntimeService.list).toHaveBeenNthCalledWith(2, { chatId: "chat", offset: 1 });
    expect(agentRuntimeService.events).toHaveBeenCalledTimes(1);
  });

  it("supports all saved records and stable engine/session filters", async () => {
    const user = userEvent.setup();
    show();
    await screen.findByText("Saved answer");
    await user.selectOptions(screen.getByLabelText("范围"), "all");
    await user.type(screen.getByLabelText("引擎 ID（选填）"), "claude");
    await user.type(screen.getByLabelText("会话 ID（选填）"), "old-session");
    await user.click(screen.getByRole("button", { name: "应用筛选" }));
    await waitFor(() => expect(agentRuntimeService.list).toHaveBeenLastCalledWith({ engineId: "claude", acpSessionId: "old-session", offset: 0 }));
    await user.selectOptions(screen.getByLabelText("范围"), "session");
    await user.click(screen.getByRole("button", { name: "应用筛选" }));
    await waitFor(() => expect(agentRuntimeService.list).toHaveBeenLastCalledWith({ engineId: "codex", acpSessionId: "stable-session", offset: 0 }));
  });

  it("discards a previous run's slow response after selecting another run", async () => {
    const user = userEvent.setup();
    let resolve!: (value: AcpRunEventPage) => void;
    vi.mocked(agentRuntimeService.list).mockResolvedValue({ runs: [run("r1"), run("r2", { engineId: "claude" })], hasMore: false });
    vi.mocked(agentRuntimeService.events).mockReturnValueOnce(new Promise((done) => { resolve = done; }))
      .mockResolvedValueOnce({ events: [chunk(1, "Second run")], hasMore: false });
    show();
    await user.click(await screen.findByRole("button", { name: /claude/ }));
    await screen.findByText("Second run");
    await act(async () => { resolve({ events: [chunk(1, "Stale first run")], hasMore: false }); });
    expect(screen.queryByText("Stale first run")).toBeNull();
  });

  it("surfaces read errors and allows retry", async () => {
    vi.mocked(agentRuntimeService.list).mockRejectedValueOnce(new Error("journal unavailable"));
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent("journal unavailable");
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByText("Saved answer")).toBeInTheDocument();
  });

  it("opens the selected run's original chat and checkpoint identities", async () => {
    const openCheckpoint = vi.fn();
    vi.mocked(agentRuntimeService.list).mockResolvedValue({ runs: [run("old-run", {
      chatId: "old-tab", checkpointId: "old-checkpoint", acpSessionId: "stable-session",
    })], hasMore: false });
    render(<ChatRunHistoryPanel chatId="new-tab" engineId="codex" acpSessionId="stable-session"
      open onOpenChange={vi.fn()} onOpenCheckpoint={openCheckpoint} />);
    await userEvent.click(await screen.findByRole("button", { name: "查看此回合检查点" }));
    expect(openCheckpoint).toHaveBeenCalledWith("old-tab", "old-checkpoint");
  });

  it("does not offer a checkpoint action for a run without one", async () => {
    render(<ChatRunHistoryPanel chatId="chat" open onOpenChange={vi.fn()} onOpenCheckpoint={vi.fn()} />);
    await screen.findByText("Saved answer");
    expect(screen.queryByRole("button", { name: "查看此回合检查点" })).not.toBeInTheDocument();
  });
});

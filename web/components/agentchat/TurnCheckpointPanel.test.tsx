import "@/i18n";
import i18n from "i18next";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnCheckpointRecord, TurnCheckpointReview } from "@/types/turnCheckpoint";
import TurnCheckpointPanel from "./TurnCheckpointPanel";

const service = vi.hoisted(() => ({ list: vi.fn(), review: vi.fn(), restore: vi.fn() }));
vi.mock("@/services/turnCheckpointService", () => ({ turnCheckpointService: service }));

const record: TurnCheckpointRecord = {
  id: "checkpoint-1", chatId: "chat-1", turnId: "turn-1", cwd: "/tmp/fixture",
  createdAt: "2026-10-22T00:00:00Z", completedAt: "2026-10-22T00:00:01Z",
  outcome: "completed", before: null, after: null, unavailableReason: null, restoredAt: null,
};
const review: TurnCheckpointReview = {
  record, revision: "reviewed-fingerprint", canRestore: true, blockedReason: null,
  files: [{ path: "a.txt", status: "modified", binary: false, conflict: false, supported: true,
    beforeContent: "user's pre-turn edit", afterContent: "agent changed text", previewOmitted: false }],
};

describe("TurnCheckpointPanel", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.clearAllMocks();
    service.list.mockResolvedValue([record]);
    service.review.mockResolvedValue(review);
    service.restore.mockResolvedValue({ restoredPaths: ["a.txt"], recoveryId: "recovery", warning: null });
  });

  it("requires explicit review confirmation and submits the backend revision", async () => {
    render(<TurnCheckpointPanel chatId="chat-1" open onOpenChange={vi.fn()} generating={false} />);
    await screen.findByText("user's pre-turn edit");
    expect(screen.getByText("agent changed text")).toBeInTheDocument();
    const restore = screen.getByRole("button", { name: /Restore whole turn/ });
    expect(restore).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(restore).toBeEnabled();
    service.review.mockResolvedValue({ ...review, canRestore: false, blockedReason: "Already restored" });
    fireEvent.click(restore);
    await waitFor(() => expect(service.restore).toHaveBeenCalledWith("checkpoint-1", "reviewed-fingerprint"));
    expect(await screen.findByText(/Restored 1 files/)).toBeInTheDocument();
  });

  it("shows a later-edit conflict and cannot confirm or restore it", async () => {
    service.review.mockResolvedValue({ ...review, canRestore: false, blockedReason: "Later edit preserved" });
    render(<TurnCheckpointPanel chatId="chat-1" open onOpenChange={vi.fn()} generating={false} />);
    await screen.findByText("Later edit preserved");
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: /Restore whole turn/ })).toBeDisabled();
    expect(service.restore).not.toHaveBeenCalled();
  });

  it("blocks restore while the active turn is generating even if review was previously restorable", async () => {
    render(<TurnCheckpointPanel chatId="chat-1" open onOpenChange={vi.fn()} generating />);
    await screen.findByText("user's pre-turn edit");
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: /Restore whole turn/ })).toBeDisabled();
  });

  it("invalidates a rejected stale review until explicitly refreshed", async () => {
    service.restore.mockRejectedValue(new Error("Files changed since review"));
    render(<TurnCheckpointPanel chatId="chat-1" open onOpenChange={vi.fn()} generating={false} />);
    await screen.findByText("user's pre-turn edit");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Restore whole turn/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Files changed since review");
    expect(screen.queryByRole("button", { name: /Restore whole turn/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh review" }));
    await screen.findByText("user's pre-turn edit");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("does not display a late review response from a previous chat", async () => {
    let resolveOld!: (value: TurnCheckpointReview) => void;
    service.review.mockImplementationOnce(() => new Promise<TurnCheckpointReview>((resolve) => { resolveOld = resolve; }));
    const rendered = render(<TurnCheckpointPanel chatId="chat-1" open onOpenChange={vi.fn()} generating={false} />);
    await waitFor(() => expect(service.review).toHaveBeenCalledWith("checkpoint-1"));
    service.list.mockResolvedValue([]);
    rendered.rerender(<TurnCheckpointPanel chatId="chat-2" open onOpenChange={vi.fn()} generating={false} />);
    await waitFor(() => expect(service.list).toHaveBeenLastCalledWith("chat-2"));
    await act(async () => resolveOld(review));
    expect(screen.queryByText("user's pre-turn edit")).not.toBeInTheDocument();
  });

  it("honestly reports binary preview omission without disabling a safe binary restore", async () => {
    service.review.mockResolvedValue({ ...review, files: [{ ...review.files[0], path: "image.png", binary: true,
      beforeContent: null, afterContent: null, previewOmitted: true }] });
    render(<TurnCheckpointPanel chatId="chat-1" open onOpenChange={vi.fn()} generating={false} />);
    await screen.findByText(/Binary or large-file text preview omitted/);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: /Restore whole turn/ })).toBeEnabled();
  });

  it("reviews an explicit historical checkpoint even outside the recent 200 records", async () => {
    let resolveList!: (records: TurnCheckpointRecord[]) => void;
    service.list.mockImplementationOnce(() => new Promise<TurnCheckpointRecord[]>((resolve) => { resolveList = resolve; }));
    render(<TurnCheckpointPanel chatId="chat-1" initialCheckpointId="checkpoint-1" open onOpenChange={vi.fn()} generating={false} />);
    await screen.findByText("user's pre-turn edit");
    await act(async () => resolveList(Array.from({ length: 200 }, (_, index) => ({ ...record, id: `recent-${index}` }))));
    expect(screen.getByRole("combobox")).toHaveValue("checkpoint-1");
    expect(service.review).toHaveBeenCalledTimes(1);
    expect(service.review).toHaveBeenCalledWith("checkpoint-1");
    expect(screen.getByText("user's pre-turn edit")).toBeInTheDocument();
    expect(service.restore).not.toHaveBeenCalled();
  });
});

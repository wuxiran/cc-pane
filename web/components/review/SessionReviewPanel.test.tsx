import "@/i18n";
import i18n from "i18next";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gitService, type GitChangedFile } from "@/services/gitService";
import { computeTextDiff } from "@/services/agentChatService";
import { turnCheckpointService } from "@/services/turnCheckpointService";
import type { DiffResult } from "@/services/localHistoryService";
import type { TurnCheckpointRecord } from "@/types/turnCheckpoint";
import SessionReviewPanel from "./SessionReviewPanel";
import { reviewFilePath } from "./reviewData";

const { openEditor } = vi.hoisted(() => ({ openEditor: vi.fn() }));
vi.mock("@/stores/usePanesStore", () => ({ usePanesStore: { getState: () => ({ openEditor }) } }));
vi.mock("@/services/gitService", () => ({ gitService: { getRepoInfo: vi.fn(), getChangedFiles: vi.fn(), getBranchReview: vi.fn(), getLocalBranches: vi.fn(), getDiff: vi.fn() } }));
vi.mock("@/services/agentChatService", () => ({ computeTextDiff: vi.fn() }));
vi.mock("@/services/turnCheckpointService", () => ({ turnCheckpointService: { list: vi.fn(), review: vi.fn(), beginCli: vi.fn(), finishCli: vi.fn() } }));
const file: GitChangedFile = { status: "modified", oldPath: "a.ts", newPath: "a.ts", oldMode: "100644", newMode: "100644" };
const diff: DiffResult = { hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1,
  lines: [{ changeType: "delete", content: "old value", oldLineNo: 1, newLineNo: null, inlineChanges: null },
    { changeType: "insert", content: "new value", oldLineNo: null, newLineNo: 1, inlineChanges: null }] }],
  stats: { additions: 1, deletions: 1, changes: 2 }, isBinary: false, truncated: false };
const record: TurnCheckpointRecord = { id: "checkpoint", chatId: "cli:session", turnId: "turn", cwd: "/repo", createdAt: "2026-10-25T00:00:00Z", completedAt: "2026-10-25T00:00:01Z", outcome: "manual-completed", before: null, after: null, unavailableReason: null, restoredAt: null };

beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.clearAllMocks();
  vi.mocked(gitService.getRepoInfo).mockResolvedValue({ state: "ok", repoRoot: "/repo", branch: "feature", hasChanges: true });
  vi.mocked(gitService.getLocalBranches).mockResolvedValue(["main", "feature"]);
  vi.mocked(gitService.getChangedFiles).mockResolvedValue([file]);
  vi.mocked(gitService.getBranchReview).mockResolvedValue({ baseCommit: "base-sha", headCommit: "head-sha", files: [file] });
  vi.mocked(gitService.getDiff).mockResolvedValue(diff);
  vi.mocked(computeTextDiff).mockResolvedValue(diff);
  vi.mocked(turnCheckpointService.list).mockResolvedValue([]);
});

describe("SessionReviewPanel", () => {
  it("renders real file diffs, exact totals, folding, wrapping and current-file editor navigation", async () => {
    const close = vi.fn();
    render(<SessionReviewPanel open onOpenChange={close} projectPath="/repo/sub" />);
    expect(await screen.findByText("new value")).toBeVisible();
    expect(gitService.getDiff).toHaveBeenCalledWith("/repo/sub", { mode: "worktreeVsHead", file });
    expect(screen.getByLabelText("Total changed lines")).toHaveTextContent("+1-1");
    expect(screen.getAllByText("+1")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Collapse all files" }));
    expect(screen.queryByText("new value")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand all files" }));
    fireEvent.click(screen.getByRole("button", { name: "Wrap lines" }));
    expect(screen.getByRole("button", { name: "Wrap lines" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("new value")).toHaveClass("whitespace-pre");
    fireEvent.click(screen.getByRole("button", { name: "Open current file: a.ts" }));
    expect(openEditor).toHaveBeenCalledWith("/repo", "/repo/a.ts", "a.ts", undefined, { forcePaneTab: true, paneId: undefined });
    expect(close).toHaveBeenCalledWith(false);
  });

  it("compares branch files against the captured merge-base and HEAD SHAs", async () => {
    render(<SessionReviewPanel open onOpenChange={vi.fn()} projectPath="/repo" />);
    await screen.findByText("new value");
    fireEvent.change(screen.getByLabelText("Review scope"), { target: { value: "branch" } });
    await waitFor(() => expect(gitService.getDiff).toHaveBeenCalledWith("/repo", { mode: "commitVsCommit", oldRev: "base-sha", newRev: "head-sha", file }));
    fireEvent.change(screen.getByLabelText("Base branch"), { target: { value: "release" } });
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    await waitFor(() => expect(gitService.getBranchReview).toHaveBeenCalledWith("/repo", "release"));
  });

  it("requires a base choice when there is no conventional main branch", async () => {
    vi.mocked(gitService.getLocalBranches).mockResolvedValue(["develop", "feature"]);
    render(<SessionReviewPanel open onOpenChange={vi.fn()} projectPath="/repo" />);
    await screen.findByText("new value");
    fireEvent.change(screen.getByLabelText("Review scope"), { target: { value: "branch" } });
    await screen.findByText("Choose the branch to compare against.");
    expect(screen.getByRole("button", { name: "Compare" })).toBeDisabled();
    expect(gitService.getBranchReview).not.toHaveBeenCalled();
  });

  it("does not substitute working-tree changes for an unrecorded CLI turn", async () => {
    render(<SessionReviewPanel open onOpenChange={vi.fn()} projectPath="/repo" checkpointChatId="cli:session" cliSessionId="session" />);
    await screen.findByText("new value");
    fireEvent.change(screen.getByLabelText("Review scope"), { target: { value: "turn" } });
    expect(await screen.findByText(/No completed recorded turn yet/)).toBeVisible();
    expect(screen.queryByText("new value")).not.toBeInTheDocument();
    expect(turnCheckpointService.review).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled();
  });

  it("completes manual CLI recording and reviews only the recorded before/after contents", async () => {
    const active = { ...record, completedAt: null, outcome: "running" };
    vi.mocked(turnCheckpointService.beginCli).mockImplementation(async () => {
      vi.mocked(turnCheckpointService.list).mockResolvedValue([active]); return active;
    });
    vi.mocked(turnCheckpointService.finishCli).mockImplementation(async () => {
      vi.mocked(turnCheckpointService.list).mockResolvedValue([record]); return record;
    });
    vi.mocked(turnCheckpointService.review).mockResolvedValue({ record, revision: "revision", canRestore: false, blockedReason: "manual", files: [
      { path: "recorded.ts", status: "modified", beforeContent: "captured before", afterContent: "captured after", binary: false, supported: true, conflict: false, previewOmitted: false },
    ] });
    render(<SessionReviewPanel open onOpenChange={vi.fn()} projectPath="/repo" checkpointChatId="cli:session" cliSessionId="session" />);
    await screen.findByText("new value");
    fireEvent.change(screen.getByLabelText("Review scope"), { target: { value: "turn" } });
    fireEvent.click(await screen.findByRole("button", { name: "Start recording" }));
    fireEvent.click(await screen.findByRole("button", { name: "Finish recording" }));
    expect(await screen.findByText("recorded.ts")).toBeVisible();
    expect(turnCheckpointService.beginCli).toHaveBeenCalledWith("session");
    expect(turnCheckpointService.finishCli).toHaveBeenCalledWith("session", "checkpoint");
    await waitFor(() => expect(computeTextDiff).toHaveBeenCalledWith("captured before", "captured after"));
  });

  it("ignores an obsolete diff request when the scope changes", async () => {
    let resolve!: (value: DiffResult) => void;
    vi.mocked(gitService.getDiff).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    render(<SessionReviewPanel open onOpenChange={vi.fn()} projectPath="/repo" checkpointChatId="chat" />);
    await waitFor(() => expect(gitService.getDiff).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Review scope"), { target: { value: "turn" } });
    await act(async () => resolve(diff));
    expect(screen.queryByText("new value")).not.toBeInTheDocument();
    expect(screen.getByText(/No completed recorded turn yet/)).toBeVisible();
  });

  it("keeps per-file errors visible and labels partial totals", async () => {
    vi.mocked(gitService.getDiff).mockRejectedValue(new Error("file changed while reading"));
    render(<SessionReviewPanel open onOpenChange={vi.fn()} projectPath="/repo" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("file changed while reading");
    expect(await screen.findByText("Text totals are incomplete")).toBeVisible();
    expect(within(screen.getByLabelText("Changed files")).getByText("a.ts")).toBeVisible();
  });
});

it("rejects repository traversal and absolute file paths", () => {
  expect(reviewFilePath("/repo", "../other")).toBeNull();
  expect(reviewFilePath("/repo", "/other")).toBeNull();
  expect(reviewFilePath("C:\\repo", "C:\\other")).toBeNull();
  expect(reviewFilePath("C:\\repo", "src/a.ts")).toBe("C:\\repo\\src/a.ts");
});

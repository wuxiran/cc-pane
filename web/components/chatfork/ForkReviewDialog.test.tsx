import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ForkComparison, ForkReviewRecord } from "@/types/forkReview";
import { forkReviewService } from "@/services/forkReviewService";
import ForkReviewDialog from "./ForkReviewDialog";

vi.mock("@/services/forkReviewService", () => ({
  forkReviewService: { list: vi.fn(), compare: vi.fn(), apply: vi.fn() },
}));
vi.mock("react-i18next", async (importOriginal) => ({ ...await importOriginal<typeof import("react-i18next")>(), useTranslation: () => ({
  t: (_key: string, options: Record<string, unknown> = {}) => String(options.defaultValue ?? _key).replace(/{{(\w+)}}/g, (_, key: string) => String(options[key] ?? "")),
}) }));
const record = (id = "fork-a"): ForkReviewRecord => ({
  id, createdAt: "2026-10-19T00:00:00Z", mode: "worktree", sourceCwd: "/parent", targetCwd: `/fork/${id}`,
  sourceSessionId: "parent-session", title: id,
  baseline: { repositoryRoot: "/parent", head: "abc123", tree: "tree", fingerprint: "base", snapshotRepository: "/snapshot" },
});
const comparison = (): ForkComparison => ({
  record: record(), revision: "preview-1", parentFingerprint: "parent", childFingerprint: "child", sharedDirectory: false,
  files: [{ path: "file.ts", status: "modified", binary: false, supported: true, parentChanged: false, conflict: false,
    baseContent: "old\n", childContent: "new\n", parentContent: "old\n",
    hunks: [{ id: "h1", header: "@@ -1 +1 @@", patch: "-old\n+new", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 },
      { id: "h2", header: "@@ -20 +20 @@", patch: "-old two\n+new two", oldStart: 20, oldLines: 1, newStart: 20, newLines: 1 }],
  }],
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(forkReviewService.list).mockResolvedValue([record()]);
  vi.mocked(forkReviewService.compare).mockResolvedValue(comparison());
  vi.mocked(forkReviewService.apply).mockResolvedValue({ appliedPaths: ["file.ts"], revision: "preview-2" });
});
const open = () => render(<ForkReviewDialog open onOpenChange={vi.fn()} forkReviewId="fork-a" />);

describe("ForkReviewDialog", () => {
  it("requires explicit selection and submits only the selected hunk with the preview revision", async () => {
    open();
    const hunk = await screen.findByRole("checkbox", { name: "Select hunk 1" });
    const adopt = screen.getByRole("button", { name: "Adopt into parent directory" });
    expect(adopt).toBeDisabled();
    expect(screen.getByText(/Parent: \/parent/)).toHaveTextContent("parent-session");
    await userEvent.click(hunk);
    await userEvent.click(adopt);
    await waitFor(() => expect(forkReviewService.apply).toHaveBeenCalledWith("fork-a", { revision: "preview-1", selections: [{ path: "file.ts", hunkIds: ["h1"] }] }));
  });
  it("keeps shared-directory forks read-only", async () => {
    vi.mocked(forkReviewService.compare).mockResolvedValue({ ...comparison(), sharedDirectory: true });
    open();
    expect(await screen.findByRole("checkbox", { name: "Select file file.ts" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Adopt into parent directory" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("cannot be attributed");
  });
  it("blocks conflicted files and does not offer text-hunk adoption for binary files", async () => {
    const data = comparison(); data.files[0].conflict = true; data.files[0].binary = true;
    vi.mocked(forkReviewService.compare).mockResolvedValue(data);
    open();
    expect(await screen.findByRole("checkbox", { name: "Select file file.ts" })).toBeDisabled();
    expect(screen.queryByRole("checkbox", { name: "Select hunk 1" })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("conflicts");
  });
  it("allows a compatible hunk from a conflicted text file while blocking whole-file adoption", async () => {
    const data = comparison(); data.files[0].conflict = true; data.files[0].parentChanged = true;
    vi.mocked(forkReviewService.compare).mockResolvedValue(data);
    open();
    expect(await screen.findByRole("checkbox", { name: "Select file file.ts" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("selected changes will be checked for conflicts again");
    const compatible = screen.getByRole("checkbox", { name: "Select hunk 2" });
    expect(compatible).toBeEnabled();
    await userEvent.click(compatible);
    await userEvent.click(screen.getByRole("button", { name: "Adopt into parent directory" }));
    await waitFor(() => expect(forkReviewService.apply).toHaveBeenCalledWith("fork-a", { revision: "preview-1", selections: [{ path: "file.ts", hunkIds: ["h2"] }] }));
  });
  it.each(["added", "deleted"] as const)("shows the actual %s text diff but only allows whole-file selection", async (status) => {
    const data = comparison(); data.files[0].status = status; data.files[0].wholeFileOnly = true;
    data.files[0].hunks = [data.files[0].hunks[0]];
    data.files[0].hunks[0].patch = status === "added" ? "+new text" : "-deleted text";
    vi.mocked(forkReviewService.compare).mockResolvedValue(data);
    open();
    const file = await screen.findByRole("checkbox", { name: "Select file file.ts" });
    expect(screen.getByText(status === "added" ? "+new text" : "-deleted text")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Select hunk 1" })).not.toBeInTheDocument();
    await userEvent.click(file);
    await userEvent.click(screen.getByRole("button", { name: "Adopt into parent directory" }));
    await waitFor(() => expect(forkReviewService.apply).toHaveBeenCalledWith("fork-a", { revision: "preview-1", selections: [{ path: "file.ts" }] }));
  });
  it("honors an explicit whole-file restriction for modified text files", async () => {
    const data = comparison(); data.files[0].wholeFileOnly = true;
    vi.mocked(forkReviewService.compare).mockResolvedValue(data);
    open();
    expect(await screen.findByRole("checkbox", { name: "Select file file.ts" })).toBeEnabled();
    expect(screen.getByText("+new")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Select hunk 1" })).not.toBeInTheDocument();
  });
  it("bounds rendered diff lines and keeps complete hunk IDs selectable across pages", async () => {
    const data = comparison();
    data.files[0].hunks[0].patch = Array.from({ length: 5000 }, (_, index) => `+line ${index}`).join("\n");
    vi.mocked(forkReviewService.compare).mockResolvedValue(data);
    open();
    const first = await screen.findByRole("checkbox", { name: "Select hunk 1" });
    expect(screen.getByLabelText("Fork changes").querySelectorAll("pre span")).toHaveLength(2000);
    expect(screen.getByRole("status")).toHaveTextContent("Preview limited to 2000 lines");
    expect(screen.queryByText("+line 4999")).not.toBeInTheDocument();
    await userEvent.click(first);
    await userEvent.click(screen.getByRole("button", { name: "Next hunks" }));
    const second = screen.getByRole("checkbox", { name: "Select hunk 2" });
    expect(second).toBeEnabled();
    await userEvent.click(second);
    await userEvent.click(screen.getByRole("button", { name: "Adopt into parent directory" }));
    await waitFor(() => expect(forkReviewService.apply).toHaveBeenCalledWith("fork-a", { revision: "preview-1", selections: [{ path: "file.ts", hunkIds: ["h1", "h2"] }] }));
  });
  it("keeps adoption success visible when the backend reports a refresh warning", async () => {
    vi.mocked(forkReviewService.apply).mockResolvedValue({ appliedPaths: ["file.ts"], revision: "preview-2", refreshWarning: "Snapshot refresh unavailable; changes were adopted." });
    open();
    await userEvent.click(await screen.findByRole("checkbox", { name: "Select file file.ts" }));
    await userEvent.click(screen.getByRole("button", { name: "Adopt into parent directory" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Snapshot refresh unavailable; changes were adopted."));
    expect(screen.getByRole("status")).toHaveTextContent("Adopted 1 files");
  });
  it("requires a fresh preview after a stale rejection and clears old selections", async () => {
    vi.mocked(forkReviewService.apply).mockRejectedValue(new Error("The preview is stale"));
    open();
    await userEvent.click(await screen.findByRole("checkbox", { name: "Select file file.ts" }));
    await userEvent.click(screen.getByRole("button", { name: "Adopt into parent directory" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Reload the comparison");
    expect(screen.getByRole("button", { name: "Adopt into parent directory" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Reload comparison" }));
    expect(await screen.findByRole("checkbox", { name: "Select file file.ts" })).not.toBeChecked();
    expect(forkReviewService.apply).toHaveBeenCalledTimes(1);
  });
  it("filters sibling candidates and shows A/B deltas without changing the adoption target", async () => {
    const second = record("fork-b");
    const unrelated = { ...record("other"), sourceSessionId: "unrelated" };
    vi.mocked(forkReviewService.list).mockResolvedValue([record(), second, unrelated]);
    vi.mocked(forkReviewService.compare).mockImplementation(async (id) => {
      const data = comparison();
      if (id === second.id) { data.record = second; data.files[0].childContent = "alternative\n"; }
      return data;
    });
    open();
    await screen.findByRole("checkbox", { name: "Select file file.ts" });
    expect(screen.queryByRole("option", { name: /other ·/ })).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Compare with another candidate"), "fork-b");
    expect(await screen.findByText(/Other candidate → selected candidate/)).toBeInTheDocument();
    expect(screen.getByText("-alternative")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Select file file.ts" }));
    await userEvent.click(screen.getByRole("button", { name: "Adopt into parent directory" }));
    await waitFor(() => expect(forkReviewService.apply).toHaveBeenCalledWith("fork-a", { revision: "preview-1", selections: [{ path: "file.ts" }] }));
  });
});

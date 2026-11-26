import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type {
  GitConflictSummary,
  GitConflictVersions,
  GitResolveConflictResult,
} from "@/services/gitService";
import ConflictResolveDialog from "./ConflictResolveDialog";

const listConflicts = vi.fn();
const getConflictVersions = vi.fn();
const resolveConflict = vi.fn();

vi.mock("@/services/gitService", () => ({
  gitService: {
    listConflicts: (...args: unknown[]) => listConflicts(...args),
    getConflictVersions: (...args: unknown[]) => getConflictVersions(...args),
    resolveConflict: (...args: unknown[]) => resolveConflict(...args),
  },
}));

function summary(files: GitConflictSummary["files"], mergeState: GitConflictSummary["mergeState"] = "merging"): GitConflictSummary {
  return { mergeState, hasConflicts: files.length > 0, files, theirsRef: "feature/x" };
}

function text(content: string | null, overrides = {}) {
  return { content, size: content?.length ?? 0, isBinary: false, tooLarge: false, ...overrides };
}

function versions(overrides: Partial<GitConflictVersions> = {}): GitConflictVersions {
  return {
    path: "src/app.ts",
    absolutePath: "/repo/src/app.ts",
    base: text("base"),
    ours: text("ours-content"),
    theirs: text("theirs-content"),
    result: text("<<<<<<< ours"),
    ...overrides,
  };
}

const TEXT_FILE: GitConflictSummary["files"][number] = {
  path: "src/app.ts",
  absolutePath: "/repo/src/app.ts",
  isBinary: false,
  stages: [
    { kind: "base", stage: 1, blob: "b", mode: "100644" },
    { kind: "ours", stage: 2, blob: "o", mode: "100644" },
    { kind: "theirs", stage: 3, blob: "t", mode: "100644" },
  ],
};

const BINARY_FILE: GitConflictSummary["files"][number] = {
  path: "logo.png",
  absolutePath: "/repo/logo.png",
  isBinary: true,
  stages: [
    { kind: "ours", stage: 2, blob: "o", mode: "100644" },
    { kind: "theirs", stage: 3, blob: "t", mode: "100644" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  listConflicts.mockResolvedValue(summary([TEXT_FILE]));
  getConflictVersions.mockResolvedValue(versions());
  resolveConflict.mockResolvedValue({
    path: "src/app.ts",
    staged: true,
    remainingConflicts: 0,
  } satisfies GitResolveConflictResult);
});

function renderDialog(props: Partial<ComponentProps<typeof ConflictResolveDialog>> = {}) {
  return render(
    <ConflictResolveDialog open onOpenChange={vi.fn()} projectPath="/repo" initialFile={null} {...props} />,
  );
}

describe("ConflictResolveDialog", () => {
  it("loads conflicts and renders the editable result pane seeded from the worktree", async () => {
    renderDialog();
    await waitFor(() => expect(listConflicts).toHaveBeenCalledWith("/repo"));
    const editor = await screen.findByTestId("conflict-result-editor");
    expect((editor as HTMLTextAreaElement).value).toBe("<<<<<<< ours");
    expect(screen.getByTestId("conflict-ours-view").textContent).toBe("ours-content");
    expect(screen.getByTestId("conflict-theirs-view").textContent).toBe("theirs-content");
  });

  it("preselects the initialFile when provided", async () => {
    listConflicts.mockResolvedValue(summary([TEXT_FILE, BINARY_FILE]));
    renderDialog({ initialFile: "logo.png" });
    await waitFor(() => expect(getConflictVersions).toHaveBeenCalledWith("/repo", "logo.png"));
  });

  it("accepting theirs overwrites the result editor", async () => {
    renderDialog();
    const editor = (await screen.findByTestId("conflict-result-editor")) as HTMLTextAreaElement;
    await userEvent.click(screen.getByRole("button", { name: i18n.t("dialogs:gitConflict.useTheirs") }));
    expect(editor.value).toBe("theirs-content");
  });

  it("saving stages the file and reports zero remaining", async () => {
    const onResolved = vi.fn();
    renderDialog({ onResolved });
    await screen.findByTestId("conflict-result-editor");
    await userEvent.click(screen.getByTestId("conflict-save"));
    await waitFor(() =>
      expect(resolveConflict).toHaveBeenCalledWith({
        path: "/repo",
        file: "src/app.ts",
        content: "<<<<<<< ours",
      }),
    );
    expect(onResolved).toHaveBeenCalledWith("src/app.ts", 0);
  });

  it("degrades binary conflicts to a notice and disables save", async () => {
    listConflicts.mockResolvedValue(summary([BINARY_FILE]));
    getConflictVersions.mockResolvedValue(
      versions({
        path: "logo.png",
        ours: text(null, { isBinary: true }),
        theirs: text(null, { isBinary: true }),
        result: text(null, { isBinary: true }),
        base: text(null),
      }),
    );
    renderDialog();
    await waitFor(() => expect(getConflictVersions).toHaveBeenCalledWith("/repo", "logo.png"));
    expect(await screen.findByTestId("conflict-save")).toBeDisabled();
    expect(screen.queryByTestId("conflict-result-editor")).not.toBeInTheDocument();
  });

  it("shows the empty state when there are no conflicts", async () => {
    listConflicts.mockResolvedValue(summary([], "clean"));
    renderDialog();
    await waitFor(() => expect(listConflicts).toHaveBeenCalled());
    expect(await screen.findByText(i18n.t("dialogs:gitConflict.noFiles"))).toBeInTheDocument();
  });
});

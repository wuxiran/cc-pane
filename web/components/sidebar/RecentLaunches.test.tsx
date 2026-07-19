import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useSshMachinesStore, useWorkspacesStore } from "@/stores";
import type { LaunchRecord } from "@/services";
import RecentLaunches from "./RecentLaunches";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/services/providerService", () => ({
  providerService: { openPathInExplorer: vi.fn(async () => undefined) },
}));

let recordId = 0;
function createRecord(overrides: Partial<LaunchRecord> = {}): LaunchRecord {
  recordId += 1;
  return {
    id: recordId,
    projectId: `proj-${recordId}`,
    projectName: `Project ${recordId}`,
    projectPath: `D:/work/project-${recordId}`,
    launchedAt: "2026-05-01T10:00:00Z",
    resumeSessionId: `sessionid${recordId}00000000`,
    ...overrides,
  };
}

function renderRecent(launchHistory: LaunchRecord[]) {
  const onOpenTerminal = vi.fn();
  const onClearHistory = vi.fn();
  const onDeleteRecord = vi.fn();
  render(
    <TooltipProvider>
      <RecentLaunches
        launchHistory={launchHistory}
        onOpenTerminal={onOpenTerminal}
        onClearHistory={onClearHistory}
        onDeleteRecord={onDeleteRecord}
      />
    </TooltipProvider>,
  );
  return { onOpenTerminal, onClearHistory, onDeleteRecord };
}

describe("RecentLaunches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordId = 0;
    useWorkspacesStore.setState({ workspaces: [] });
    useSshMachinesStore.setState({ machines: [] });
  });

  it("shows the empty state when there are no resumable records", () => {
    renderRecent([]);

    expect(screen.getByText(/No resumable sessions|无可恢复的会话|无可恢复会话/i)).toBeVisible();
  });

  it("does not render a clear button in the empty state when history is empty", () => {
    renderRecent([]);

    expect(screen.queryByRole("button", { name: /Clear history|清空/i })).not.toBeInTheDocument();
  });

  it("renders records with resume session id grouped by workspace name", () => {
    renderRecent([
      createRecord({ workspaceName: "Alpha", projectName: "Alpha App" }),
      createRecord({ workspaceName: "Beta", projectName: "Beta App" }),
    ]);

    expect(screen.getByText("Alpha")).toBeVisible();
    expect(screen.getByText("Beta")).toBeVisible();
    expect(screen.getByText("Alpha App")).toBeVisible();
    expect(screen.getByText("Beta App")).toBeVisible();
  });

  it("groups records without a workspace name under the ungrouped label", () => {
    renderRecent([createRecord({ workspaceName: undefined, projectName: "Loose App" })]);

    expect(screen.getByText(/Ungrouped|未分组/i)).toBeVisible();
    expect(screen.getByText("Loose App")).toBeVisible();
  });

  it("filters out records lacking a resume session id", () => {
    renderRecent([
      createRecord({ workspaceName: "Alpha", projectName: "Has Session" }),
      createRecord({ workspaceName: "Alpha", projectName: "No Session", resumeSessionId: undefined }),
    ]);

    expect(screen.getByText("Has Session")).toBeVisible();
    expect(screen.queryByText("No Session")).not.toBeInTheDocument();
  });

  it("collapses and expands a workspace group when clicking its header", async () => {
    const user = userEvent.setup();
    renderRecent([createRecord({ workspaceName: "Alpha", projectName: "Alpha App" })]);

    expect(screen.getByText("Alpha App")).toBeVisible();

    await user.click(screen.getByText("Alpha"));
    expect(screen.queryByText("Alpha App")).not.toBeInTheDocument();

    await user.click(screen.getByText("Alpha"));
    expect(screen.getByText("Alpha App")).toBeVisible();
  });

  it("invokes onOpenTerminal with the record's project path when a record row is clicked", () => {
    const { onOpenTerminal } = renderRecent([
      createRecord({ workspaceName: "Alpha", projectName: "Alpha App", projectPath: "D:/work/alpha" }),
    ]);

    fireEvent.click(screen.getByText("Alpha App"));

    expect(onOpenTerminal).toHaveBeenCalledWith(expect.objectContaining({
      path: "D:/work/alpha",
    }));
  });

  it("invokes onClearHistory when clicking the clear button", () => {
    const { onClearHistory } = renderRecent([createRecord({ workspaceName: "Alpha" })]);

    fireEvent.click(screen.getByRole("button", { name: /Clear history|清空/i }));

    expect(onClearHistory).toHaveBeenCalledTimes(1);
  });

  it("invokes onDeleteRecord with the row id when clicking the delete button", () => {
    const { onDeleteRecord } = renderRecent([
      createRecord({ id: 7, workspaceName: "Alpha", projectName: "Alpha App" }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: /^Delete$|^删除$/i }));

    expect(onDeleteRecord).toHaveBeenCalledWith(7);
  });
});

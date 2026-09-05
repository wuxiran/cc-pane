import "@/i18n";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/** jsdom 无布局：虚拟化器读 offsetHeight，滚动容器给 600px 视口、行给 56px */
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    if (this.classList?.contains("app-scrollbar")) return 600;
    if (this.hasAttribute?.("data-index")) return 56;
    return 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(() => 260);
});

afterEach(() => {
  vi.restoreAllMocks();
});

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

/** 与生产一致：外层滚动容器 + callback ref/state 交接（见 SessionsView） */
function ScrollHost(props: Omit<React.ComponentProps<typeof RecentLaunches>, "scrollElement">) {
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setScrollElement} className="app-scrollbar" data-testid="scroll-host">
      <RecentLaunches {...props} scrollElement={scrollElement} />
    </div>
  );
}

function renderRecent(launchHistory: LaunchRecord[]) {
  const onOpenTerminal = vi.fn();
  const onClearHistory = vi.fn();
  const onDeleteRecord = vi.fn();
  render(
    <TooltipProvider>
      <ScrollHost
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

describe("RecentLaunches virtualization", () => {
  it("长历史只渲染可视窗口内的行（标题 + 会话）", () => {
    const records = Array.from({ length: 120 }, (_, i) =>
      createRecord({ workspaceName: "Alpha", projectName: `App ${i}` }),
    );
    renderRecent(records);

    const rendered = document.querySelectorAll("[data-index]");
    expect(rendered.length).toBeGreaterThan(0);
    // 120 条记录 + 1 个组标题，可视窗口只渲染一小部分
    expect(rendered.length).toBeLessThan(40);
    expect(screen.queryByText("App 119")).not.toBeInTheDocument();
  });

  it("滚动到底部后末尾记录可见", () => {
    const records = Array.from({ length: 120 }, (_, i) =>
      createRecord({ workspaceName: "Alpha", projectName: `App ${i}` }),
    );
    renderRecent(records);

    const scroller = screen.getByTestId("scroll-host");
    scroller.scrollTop = 56 * 121;
    fireEvent.scroll(scroller);

    expect(screen.getByText("App 119")).toBeInTheDocument();
    expect(screen.queryByText("App 0")).not.toBeInTheDocument();
  });
});

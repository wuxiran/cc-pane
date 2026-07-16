import "@/i18n";
import type { ReactElement } from "react";
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePanesStore, useSshMachinesStore, useTerminalStatusStore, useWorkspacesStore } from "@/stores";
import { mockTauriInvoke } from "@/test/utils/mockTauriInvoke";
import type { LaunchRecord } from "@/services";
import type { Panel, Tab, TerminalStatusInfo } from "@/types";
import SessionsView from "./SessionsView";

// SessionsView 内嵌 RecentLaunches，其操作按钮使用统一 Tooltip，需 TooltipProvider 包裹
const render = (ui: ReactElement) => rtlRender(<TooltipProvider>{ui}</TooltipProvider>);

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/services/providerService", () => ({
  providerService: { openPathInExplorer: vi.fn(async () => undefined) },
}));

function createTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: `tab-${Math.random().toString(36).slice(2)}`,
    title: "Terminal",
    contentType: "terminal",
    projectId: "p1",
    projectPath: "D:/p1",
    sessionId: "sess-1",
    ...overrides,
  };
}

function createPanel(tabs: Tab[]): Panel {
  return { type: "panel", id: "panel-1", tabs, activeTabId: tabs[0]?.id ?? "" };
}

function statusInfo(sessionId: string, status: TerminalStatusInfo["status"]): TerminalStatusInfo {
  return { sessionId, status, lastOutputAt: Date.now(), updatedAt: Date.now() };
}

function createRecord(overrides: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    id: 1,
    projectId: "proj-1",
    projectName: "History Project",
    projectPath: "D:/work/history",
    launchedAt: "2026-05-01T10:00:00Z",
    resumeSessionId: "resume00000000",
    workspaceName: "Alpha",
    ...overrides,
  };
}

describe("SessionsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspacesStore.setState({ workspaces: [] });
    useSshMachinesStore.setState({ machines: [] });
    useTerminalStatusStore.setState({ statusMap: new Map() });
    usePanesStore.setState({ rootPane: createPanel([]) });
    mockTauriInvoke({
      list_launch_history: [],
      clear_launch_history: undefined,
      delete_launch_history: undefined,
    });
  });

  it("renders the SESSIONS header", async () => {
    render(<SessionsView onOpenTerminal={vi.fn()} />);

    expect(screen.getByText("SESSIONS")).toBeVisible();
    await waitFor(() => expect(screen.getByText(/No resumable sessions|无可恢复/i)).toBeVisible());
  });

  it("lists active terminal sessions with their titles and count", async () => {
    usePanesStore.setState({
      rootPane: createPanel([
        createTab({ id: "t1", title: "API Server", sessionId: "sess-a" }),
        createTab({ id: "t2", title: "Web Dev", sessionId: "sess-b" }),
      ]),
    });
    useTerminalStatusStore.setState({
      statusMap: new Map([
        ["sess-a", statusInfo("sess-a", "toolRunning")],
        ["sess-b", statusInfo("sess-b", "idle")],
      ]),
    });

    render(<SessionsView onOpenTerminal={vi.fn()} />);

    expect(screen.getByText(/Active \(2\)/)).toBeVisible();
    expect(screen.getByText("API Server")).toBeVisible();
    expect(screen.getByText("Web Dev")).toBeVisible();
  });

  it("excludes tabs without a session id and non-terminal tabs", () => {
    usePanesStore.setState({
      rootPane: createPanel([
        createTab({ id: "t1", title: "Live Term", sessionId: "sess-a" }),
        createTab({ id: "t2", title: "No Session", sessionId: null }),
        createTab({ id: "t3", title: "Editor Tab", sessionId: "sess-c", contentType: "editor" }),
      ]),
    });

    render(<SessionsView onOpenTerminal={vi.fn()} />);

    expect(screen.getByText(/Active \(1\)/)).toBeVisible();
    expect(screen.getByText("Live Term")).toBeVisible();
    expect(screen.queryByText("No Session")).not.toBeInTheDocument();
    expect(screen.queryByText("Editor Tab")).not.toBeInTheDocument();
  });

  it("does not render the active section when there are no live sessions", async () => {
    render(<SessionsView onOpenTerminal={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/No resumable sessions|无可恢复/i)).toBeVisible());
    expect(screen.queryByText(/Active \(/)).not.toBeInTheDocument();
  });

  it("renders launch history records fetched on mount", async () => {
    mockTauriInvoke({
      list_launch_history: [createRecord({ projectName: "History Project" })],
    });

    render(<SessionsView onOpenTerminal={vi.fn()} />);

    expect(await screen.findByText("History Project")).toBeVisible();
    expect(screen.getByText("Alpha")).toBeVisible();
  });
});

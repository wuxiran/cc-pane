import "@/i18n";
import type { ReactElement } from "react";
import { fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePanesStore, useSshMachinesStore, useTerminalStatusStore, useWorkspacesStore } from "@/stores";
import { mockTauriInvoke } from "@/test/utils/mockTauriInvoke";
import type { LaunchRecord } from "@/services";
import type { Panel, Tab, TerminalStatusInfo } from "@/types";
import SessionsView from "./SessionsView";

// SessionsView 内嵌 RecentLaunches，其操作按钮使用统一 Tooltip，需 TooltipProvider 包裹
const render = (ui: ReactElement) => rtlRender(<TooltipProvider>{ui}</TooltipProvider>);

/** jsdom 无布局：RecentLaunches 虚拟化读 offsetHeight，滚动容器给 600px 视口、行给 56px */
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

vi.mock("@/components/ui/toast", () => ({
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
      list_acp_chat_history: [],
      clear_launch_history: undefined,
      delete_launch_history: undefined,
    });
  });

  it("renders the header, kind filter and empty state without an active section", async () => {
    render(<SessionsView onOpenTerminal={vi.fn()} />);

    expect(screen.getByText(/^Sessions$|^会话$/)).toBeVisible();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    await waitFor(() => expect(screen.getByText(/No resumable sessions|无可恢复/i)).toBeVisible());
    expect(screen.queryByText(/Active \(/)).not.toBeInTheDocument();
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

  it("lists agent chats and CLI launches in one list, each row tagged, and filters by kind", async () => {
    useWorkspacesStore.setState({
      workspaces: [{ id: "w1", name: "Alpha", createdAt: "", projects: [{ id: "p1", path: "D:/work/history" }] }] as never,
    });
    mockTauriInvoke({
      list_launch_history: [createRecord({ projectName: "History Project", cliTool: "claude" })],
      list_acp_chat_history: [
        { acpSessionId: "acp-1", engineId: "codex", cwd: "D:\\work\\history\\sub", title: "Fix the bug", createdAt: 1, updatedAt: Date.parse("2026-05-02T10:00:00Z") },
        { acpSessionId: "acp-2", engineId: "claude", cwd: "/elsewhere", title: "Loose chat", createdAt: 1, updatedAt: 2 },
      ],
    });

    render(<SessionsView onOpenTerminal={vi.fn()} />);

    expect(await screen.findByText("History Project")).toBeVisible();
    expect(await screen.findByText("Fix the bug")).toBeVisible();
    // 对话按 cwd 归到所属工作空间；归不上的进「未分组」。
    expect(screen.getAllByText("Alpha")).toHaveLength(1);
    expect(screen.getByText(/Ungrouped|未分组/)).toBeVisible();
    const kinds = () => Array.from(document.querySelectorAll("[data-session-kind]")).map((el) => el.getAttribute("data-session-kind"));
    // Alpha 组内按时间倒序：对话（5/2）在启动记录（5/1）之前。
    expect(kinds()).toEqual(["chat", "cli", "chat"]);
    expect(document.querySelector('[data-session-kind="cli"]')?.textContent).toMatch(/(Terminal|终端) · claude/);
    expect(document.querySelector('[data-session-kind="chat"]')?.textContent).toMatch(/(Chat|对话) · codex/);

    fireEvent.click(screen.getByRole("radio", { name: /^Chat$|^对话$/ }));
    expect(kinds()).toEqual(["chat", "chat"]);
    expect(screen.queryByText("History Project")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: /^Terminal$|^终端$/ }));
    expect(kinds()).toEqual(["cli"]);
    expect(screen.queryByText("Fix the bug")).not.toBeInTheDocument();
  });
});

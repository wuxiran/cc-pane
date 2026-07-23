import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityView } from "@/stores/useActivityBarStore";
import { useProvidersStore, useSshMachinesStore, useWorkspacesStore } from "@/stores";
import { historyService, localHistoryService } from "@/services";
import Sidebar from "./Sidebar";

vi.mock("@/services/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/runtime")>()),
  isTauriRuntime: () => false,
}));

vi.mock("@/services/historyService", () => ({
  historyService: { list: vi.fn().mockResolvedValue([]) },
}));
vi.mock("@/services/localHistoryService", () => ({
  localHistoryService: { initProjectHistory: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("@/components/sidebar/ExplorerView", () => ({
  default: () => <div data-testid="explorer-view" />,
}));
vi.mock("@/components/sidebar/SessionsView", () => ({
  default: () => <div data-testid="sessions-view" />,
}));
vi.mock("@/components/sidebar/OrchestratorView", () => ({
  default: () => <div data-testid="orchestrator-view" />,
}));
vi.mock("@/components/sidebar/FileBrowserView", () => ({
  default: () => <div data-testid="file-browser-view" />,
}));
vi.mock("@/components/sidebar/SshMachinesView", () => ({
  default: () => <div data-testid="ssh-machines-view" />,
}));
vi.mock("@/components/sidebar/WorkspaceEnvironmentPanel", () => ({
  default: () => <div data-testid="workspace-env-panel" />,
}));

function renderSidebar(activeView: ActivityView = "explorer") {
  return render(<Sidebar activeView={activeView} onOpenTerminal={vi.fn()} />);
}

describe("Sidebar", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspacesStore.setState({
      workspaces: [],
      load: vi.fn().mockResolvedValue(undefined),
    } as never);
    useProvidersStore.setState({ loadProviders: vi.fn() } as never);
    useSshMachinesStore.setState({ load: vi.fn().mockResolvedValue(undefined) } as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the view matching activeView and always mounts the environment panel", () => {
    renderSidebar("explorer");

    expect(screen.getByTestId("explorer-view")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-env-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("sessions-view")).not.toBeInTheDocument();
  });

  it.each([
    ["sessions", "sessions-view"],
    ["files", "file-browser-view"],
    ["ssh", "ssh-machines-view"],
    ["orchestration", "orchestrator-view"],
  ] as const)("shows %s view when active", (view, testId) => {
    renderSidebar(view as ActivityView);

    expect(screen.getByTestId(testId)).toBeInTheDocument();
    expect(screen.queryByTestId("explorer-view")).not.toBeInTheDocument();
  });

  it("loads workspaces, providers and ssh machines on mount, then warms history", async () => {
    renderSidebar();

    await waitFor(() => expect(useWorkspacesStore.getState().load).toHaveBeenCalled());
    expect(useProvidersStore.getState().loadProviders).toHaveBeenCalled();
    expect(useSshMachinesStore.getState().load).toHaveBeenCalled();
    expect(vi.mocked(historyService.list)).toHaveBeenCalledWith(1);
  });

  it("does not start history watchers for registered projects on startup", async () => {
    useWorkspacesStore.setState({
      workspaces: [
        { name: "ws1", projects: [{ path: "/p1" }, { path: "/p2" }] },
        { name: "ws2", projects: [{ path: "/p3" }] },
      ],
      load: vi.fn().mockResolvedValue(undefined),
    } as never);

    renderSidebar();

    await waitFor(() => expect(useWorkspacesStore.getState().load).toHaveBeenCalled());
    expect(vi.mocked(localHistoryService.initProjectHistory)).not.toHaveBeenCalled();
  });

  it("uses the persisted sidebar width when it is within bounds", () => {
    localStorage.setItem("cc-panes-sidebar-width", "333");
    const { container } = renderSidebar();

    expect(container.querySelector<HTMLElement>(".sidebar")!.style.width).toBe("333px");
  });

  it("falls back to the default width for out-of-range persisted values", () => {
    localStorage.setItem("cc-panes-sidebar-width", "9999");
    const { container } = renderSidebar();

    expect(container.querySelector<HTMLElement>(".sidebar")!.style.width).toBe("280px");
  });

  it("resizes via the sash within min/max bounds and persists the final width", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    const { container } = renderSidebar();
    const sidebar = container.querySelector<HTMLElement>(".sidebar")!;
    const sash = container.querySelector<HTMLElement>(".splitview-sash")!;

    fireEvent.pointerDown(sash, { clientX: 280 });
    fireEvent.pointerMove(document, { clientX: 380 });
    expect(sidebar.style.width).toBe("380px");

    // 拖过最大宽度：钳到 500
    fireEvent.pointerMove(document, { clientX: 900 });
    expect(sidebar.style.width).toBe("500px");

    fireEvent.pointerUp(document);
    expect(localStorage.getItem("cc-panes-sidebar-width")).toBe("500");
    expect(document.body.style.cursor).toBe("");
  });
});

import "@/i18n";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OrchestratorView from "./OrchestratorView";
import { useOrchestratorStore } from "@/stores";
import type { TaskBinding } from "@/types";

vi.mock("./OrchestratorFilterBar", () => ({ default: () => <div>filter-bar-stub</div> }));
vi.mock("./OrchestratorTaskTree", () => ({ default: () => <div>task-tree-stub</div> }));
vi.mock("./OrchestratorTaskCard", () => ({
  default: ({ binding }: { binding: TaskBinding }) => <div data-testid="card">{binding.title}</div>,
}));

function makeBinding(overrides: Partial<TaskBinding> = {}): TaskBinding {
  return {
    id: "b",
    title: "task",
    role: "task",
    projectPath: "/tmp/proj",
    cliTool: "claude",
    status: "running",
    progress: 0,
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

let loadBindings: ReturnType<typeof vi.fn>;
let setFilterTab: ReturnType<typeof vi.fn>;
let setViewType: ReturnType<typeof vi.fn>;

function configureStore(overrides: Record<string, unknown> = {}) {
  loadBindings = vi.fn(async () => {});
  setFilterTab = vi.fn();
  setViewType = vi.fn();
  useOrchestratorStore.setState({
    bindings: [],
    loading: false, hasMore: false, loadError: null,
    filterTab: "all",
    viewType: "list",
    loadBindings,
    setFilterTab,
    setViewType,
    ...overrides,
  } as unknown as Parameters<typeof useOrchestratorStore.setState>[0]);
}

describe("OrchestratorView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureStore();
  });

  it("loads bindings on mount", () => {
    render(<OrchestratorView onOpenTerminal={vi.fn()} />);
    expect(loadBindings).toHaveBeenCalledTimes(1);
  });

  it("renders the empty state when no bindings and not loading", () => {
    render(<OrchestratorView onOpenTerminal={vi.fn()} />);
    expect(screen.getByText(/No tasks yet|暂无/i)).toBeVisible();
  });

  it("does not render the empty state while loading", () => {
    configureStore({ bindings: [], loading: true });
    render(<OrchestratorView onOpenTerminal={vi.fn()} />);
    expect(screen.queryByText(/No tasks yet|暂无/i)).not.toBeInTheDocument();
  });

  it("renders task cards in list view", () => {
    configureStore({
      bindings: [makeBinding({ id: "a", title: "Alpha" }), makeBinding({ id: "b", title: "Beta" })],
      viewType: "list",
    });
    render(<OrchestratorView onOpenTerminal={vi.fn()} />);

    expect(screen.getByText("Alpha")).toBeVisible();
    expect(screen.getByText("Beta")).toBeVisible();
    expect(screen.queryByText("task-tree-stub")).not.toBeInTheDocument();
  });

  it("renders the tree component in tree view", () => {
    configureStore({ bindings: [makeBinding({ id: "a", title: "Alpha" })], viewType: "tree" });
    render(<OrchestratorView onOpenTerminal={vi.fn()} />);

    expect(screen.getByText("task-tree-stub")).toBeVisible();
    expect(screen.queryByTestId("card")).not.toBeInTheDocument();
  });

  it("switches the filter tab when a tab is clicked", () => {
    render(<OrchestratorView onOpenTerminal={vi.fn()} />);
    fireEvent.click(screen.getByText(/Running|运行/i));
    expect(setFilterTab).toHaveBeenCalledWith("running");
  });

  it("switches the view type when the tree button is clicked", () => {
    render(<OrchestratorView onOpenTerminal={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /^tree$/i }));
    expect(setViewType).toHaveBeenCalledWith("tree");
  });

  it("reloads bindings when the refresh button is clicked", () => {
    render(<OrchestratorView onOpenTerminal={vi.fn()} />);
    // one call on mount, one on click
    fireEvent.click(screen.getByRole("button", { name: /Refresh|刷新/i }));
    expect(loadBindings).toHaveBeenCalledTimes(2);
  });

  it("renders the filter bar without a dispatch composer", () => {
    render(<OrchestratorView onOpenTerminal={vi.fn()} />);
    expect(screen.getByText("filter-bar-stub")).toBeVisible();
    expect(screen.queryByPlaceholderText(/Enter task|输入任务/i)).not.toBeInTheDocument();
  });
  it("offers pagination and persistent retry without removing existing sidebar tasks", () => {
    const more = vi.fn(); const retry = vi.fn();
    configureStore({ bindings: [makeBinding({ title: "Retained task" })], hasMore: true, loadMoreBindings: more, retryBindings: retry });
    render(<OrchestratorView onOpenTerminal={vi.fn()} compact />);
    fireEvent.click(screen.getByRole("button", { name: "加载更多任务" })); expect(more).toHaveBeenCalledOnce();
    act(() => useOrchestratorStore.setState({ loadError: "offline", hasMore: false }));
    expect(screen.getByText("Retained task")).toBeVisible(); expect(screen.getByRole("alert")).toHaveTextContent("任务列表加载失败");
    fireEvent.click(screen.getByRole("button", { name: "重试" })); expect(retry).toHaveBeenCalledOnce();
  });

});

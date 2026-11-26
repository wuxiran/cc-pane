import "@/i18n";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OrchestratorView from "./OrchestratorView";
import { useOrchestratorStore } from "@/stores";
import type { TaskBinding } from "@/types";

vi.mock("./OrchestratorFilterBar", () => ({
  OrchestratorFilterButton: () => <div>filter-bar-stub</div>,
  OrchestratorSearchField: () => <div>search-field-stub</div>,
}));
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
let setSearchKeyword: ReturnType<typeof vi.fn>;

function configureStore(overrides: Record<string, unknown> = {}) {
  loadBindings = vi.fn(async () => {});
  setFilterTab = vi.fn();
  setViewType = vi.fn();
  setSearchKeyword = vi.fn();
  useOrchestratorStore.setState({
    bindings: [],
    loading: false, hasMore: false, loadError: null,
    filterTab: "all",
    filterWorkspace: null, filterProjectPath: null, filterRole: null, searchKeyword: "",
    viewType: "list",
    loadBindings,
    setFilterTab,
    setViewType,
    setSearchKeyword,
    ...overrides,
  } as unknown as Parameters<typeof useOrchestratorStore.setState>[0]);
}

function renderView() {
  return render(<OrchestratorView onOpenTerminal={vi.fn()} />);
}

describe("OrchestratorView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureStore();
  });

  it("loads bindings on mount and reloads when the refresh button is clicked", () => {
    configureStore({ bindings: [makeBinding({ title: "Alpha" })] });
    renderView();
    expect(loadBindings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /Refresh|刷新/i }));
    expect(loadBindings).toHaveBeenCalledTimes(2);
  });

  it("renders the empty state with a refresh action when no bindings and not loading", () => {
    renderView();
    expect(screen.getByText(/No tasks yet|暂无/i)).toBeVisible();
    const refreshButtons = screen.getAllByRole("button", { name: /Refresh|刷新/i });
    fireEvent.click(refreshButtons[refreshButtons.length - 1]);
    expect(loadBindings).toHaveBeenCalledTimes(2);
  });

  it("renders a filtered empty state that clears filters when a status tab yields nothing", () => {
    configureStore({ filterTab: "running" });
    renderView();
    expect(screen.queryByText(/暂无编排任务/)).not.toBeInTheDocument();
    expect(screen.getByText("没有符合条件的任务")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(setFilterTab).toHaveBeenCalledWith("all");
  });

  it("shows the panel title only when not embedded in the right dock", () => {
    const { unmount } = renderView();
    expect(screen.getByText("任务编排")).toBeVisible();
    unmount();
    render(<OrchestratorView onOpenTerminal={vi.fn()} compact />);
    expect(screen.queryByText("任务编排")).not.toBeInTheDocument();
  });

  it("keeps search collapsed into an icon until toggled", () => {
    renderView();
    expect(screen.queryByText("search-field-stub")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    expect(screen.getByText("search-field-stub")).toBeVisible();
  });

  it("does not render the empty state while loading", () => {
    configureStore({ bindings: [], loading: true });
    renderView();
    expect(screen.queryByText(/No tasks yet|暂无/i)).not.toBeInTheDocument();
  });

  it("renders task cards in list view", () => {
    configureStore({
      bindings: [makeBinding({ id: "a", title: "Alpha" }), makeBinding({ id: "b", title: "Beta" })],
      viewType: "list",
    });
    renderView();

    expect(screen.getByText("Alpha")).toBeVisible();
    expect(screen.getByText("Beta")).toBeVisible();
    expect(screen.queryByText("task-tree-stub")).not.toBeInTheDocument();
  });

  it("renders the tree component in tree view", () => {
    configureStore({ bindings: [makeBinding({ id: "a", title: "Alpha" })], viewType: "tree" });
    renderView();

    expect(screen.getByText("task-tree-stub")).toBeVisible();
    expect(screen.queryByTestId("card")).not.toBeInTheDocument();
  });

  it("switches the filter tab when a tab is clicked", () => {
    renderView();
    fireEvent.click(screen.getByRole("tab", { name: /Running|运行/i }));
    expect(setFilterTab).toHaveBeenCalledWith("running");
  });

  it("switches the view type when the tree button is clicked", () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: /^(tree|树)$/i }));
    expect(setViewType).toHaveBeenCalledWith("tree");
  });

  it("renders the filter bar without a dispatch composer", () => {
    renderView();
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

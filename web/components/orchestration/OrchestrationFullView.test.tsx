import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskBinding } from "@/types";
import { useActivityBarStore, useOrchestratorStore } from "@/stores";
import { useNotificationStore, type NotificationRecord } from "@/stores/useNotificationStore";
import OrchestrationFullView from "./OrchestrationFullView";

vi.mock("@/components/sidebar/OrchestratorTaskCard", () => ({
  default: ({ binding }: { binding: TaskBinding }) => (
    <div data-testid={`task-card-${binding.id}`}>{binding.title}</div>
  ),
}));
vi.mock("@/components/sidebar/OrchestratorTaskTree", () => ({
  default: () => <div data-testid="task-tree" />,
}));
vi.mock("./TaskDetailPanel", () => ({
  default: ({ binding }: { binding: TaskBinding | null }) => (
    <div data-testid="task-detail" data-binding-id={binding?.id ?? "none"} />
  ),
}));
vi.mock("./SessionOutputPreview", () => ({
  default: ({ sessionId }: { sessionId?: string | null }) => (
    <div data-testid="output-preview" data-session-id={sessionId ?? "none"} />
  ),
}));

function makeBinding(id: string, overrides?: Partial<TaskBinding>): TaskBinding {
  return {
    id,
    title: `Task ${id}`,
    role: "task",
    projectPath: "D:/proj",
    cliTool: "claude",
    status: "running",
    progress: 0,
    sortOrder: 0,
    createdAt: "2026-07-01T10:00:00Z",
    updatedAt: "2026-07-01T10:00:00Z",
    ...overrides,
  };
}

function makeNotification(overrides?: Partial<NotificationRecord>): NotificationRecord {
  return {
    id: `n-${Math.random().toString(36).slice(2)}`,
    kind: "task",
    title: "Task update",
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

const loadBindings = vi.fn().mockResolvedValue(undefined);

function setOrchestratorState(bindings: TaskBinding[], overrides?: Record<string, unknown>) {
  useOrchestratorStore.setState({
    bindings,
    loading: false,
    filterTab: "all",
    searchKeyword: "",
    viewType: "list",
    selectedTaskId: null,
    loadBindings,
    ...overrides,
  } as never);
}

describe("OrchestrationFullView", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    setOrchestratorState([]);
    useNotificationStore.setState({ notifications: [] });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads bindings on mount and shows the empty state without tasks", async () => {
    render(<OrchestrationFullView />);

    expect(screen.getByText("暂无编排任务")).toBeInTheDocument();
    await waitFor(() => expect(loadBindings).toHaveBeenCalledWith({ limit: 100 }));
  });

  it("renders the task list and auto-selects the first binding", async () => {
    setOrchestratorState([makeBinding("b1"), makeBinding("b2")]);
    render(<OrchestrationFullView />);

    expect(screen.getByTestId("task-card-b1")).toBeInTheDocument();
    await waitFor(() =>
      expect(useOrchestratorStore.getState().selectedTaskId).toBe("b1")
    );
    expect(screen.getByTestId("task-detail")).toHaveAttribute("data-binding-id", "b1");
  });

  it("selects a task on click and feeds its session into the detail panel", async () => {
    const user = userEvent.setup();
    setOrchestratorState([makeBinding("b1"), makeBinding("b2", { sessionId: "sess-2" })]);
    render(<OrchestrationFullView />);

    await user.click(screen.getByTestId("task-card-b2"));

    expect(useOrchestratorStore.getState().selectedTaskId).toBe("b2");
    expect(screen.getByTestId("task-detail")).toHaveAttribute("data-binding-id", "b2");
  });

  it("switches the task filter tab through the store", async () => {
    const user = userEvent.setup();
    const setFilterTab = vi.fn();
    setOrchestratorState([makeBinding("b1")], { setFilterTab });
    render(<OrchestrationFullView />);

    await user.click(screen.getByRole("button", { name: "运行中" }));

    expect(setFilterTab).toHaveBeenCalledWith("running");
  });

  it("forwards search input to the store", async () => {
    const user = userEvent.setup();
    const setSearchKeyword = vi.fn();
    setOrchestratorState([makeBinding("b1")], { setSearchKeyword });
    render(<OrchestrationFullView />);

    await user.type(screen.getByPlaceholderText("搜索任务"), "abc");

    expect(setSearchKeyword).toHaveBeenCalled();
  });

  it("renders the tree view when viewType is tree", () => {
    setOrchestratorState([makeBinding("b1")], { viewType: "tree" });
    render(<OrchestrationFullView />);

    expect(screen.getByTestId("task-tree")).toBeInTheDocument();
    expect(screen.queryByTestId("task-card-b1")).not.toBeInTheDocument();
  });

  it("closes via Escape using the provided onClose", () => {
    const onClose = vi.fn();
    render(<OrchestrationFullView variant="overlay" onClose={onClose} />);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("falls back to closing the activity-bar overlay without an onClose", async () => {
    const user = userEvent.setup();
    const closeOrchestrationOverlay = vi.fn();
    useActivityBarStore.setState({ closeOrchestrationOverlay } as never);
    render(<OrchestrationFullView />);

    await user.click(screen.getByRole("button", { name: "退出" }));

    expect(closeOrchestrationOverlay).toHaveBeenCalledTimes(1);
  });

  it("starts collapsed in overlay variant and expands the preview on demand", async () => {
    const user = userEvent.setup();
    setOrchestratorState([makeBinding("b1", { sessionId: "sess-1" })]);
    render(<OrchestrationFullView variant="overlay" onClose={vi.fn()} />);

    expect(screen.queryByTestId("output-preview")).not.toBeInTheDocument();

    // 折叠时缩栏按钮与拖拽柄同名，点其一即可展开
    await user.click(screen.getAllByRole("button", { name: "展开预览" })[0]);

    expect(screen.getByTestId("output-preview")).toBeInTheDocument();
    expect(window.sessionStorage.getItem("cc-panes-orchestration-right-collapsed")).toBe("false");

    await user.click(screen.getByRole("button", { name: "折叠预览" }));
    expect(screen.queryByTestId("output-preview")).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem("cc-panes-orchestration-right-collapsed")).toBe("true");
  });

  it("lists notifications and jumps to the linked task", async () => {
    const user = userEvent.setup();
    const setSelectedTaskId = vi.fn();
    setOrchestratorState([makeBinding("b1")], { setSelectedTaskId });
    useNotificationStore.setState({
      notifications: [
        makeNotification({ id: "n1", title: "Worker done", taskBindingId: "b1" }),
      ],
    });
    render(<OrchestrationFullView />);

    await user.click(screen.getByRole("button", { name: "通知" }));
    await user.click(screen.getByText("Worker done"));

    expect(setSelectedTaskId).toHaveBeenCalledWith("b1");
    // 跳回任务页
    expect(screen.getByPlaceholderText("搜索任务")).toBeInTheDocument();
  });

  it("groups notifications sharing a group key within the 5s window", async () => {
    const user = userEvent.setup();
    useNotificationStore.setState({
      notifications: [
        makeNotification({ id: "n1", title: "task one completed", groupKey: "g", timestamp: 1000 }),
        makeNotification({ id: "n2", title: "task two completed", groupKey: "g", timestamp: 2000 }),
      ],
    });
    render(<OrchestrationFullView />);

    await user.click(screen.getByRole("button", { name: "通知" }));

    expect(screen.getByText("2 个任务已完成")).toBeInTheDocument();
    expect(screen.queryByText("task two completed")).not.toBeInTheDocument();
  });

  it("filters notifications by errors and completed", async () => {
    const user = userEvent.setup();
    useNotificationStore.setState({
      notifications: [
        makeNotification({ id: "n1", title: "build failed with error" }),
        makeNotification({ id: "n2", title: "deploy completed" }),
      ],
    });
    render(<OrchestrationFullView />);
    await user.click(screen.getByRole("button", { name: "通知" }));

    await user.click(screen.getByRole("button", { name: "错误" }));
    expect(screen.getByText("build failed with error")).toBeInTheDocument();
    expect(screen.queryByText("deploy completed")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "已完成" }));
    expect(screen.getByText("deploy completed")).toBeInTheDocument();
    expect(screen.queryByText("build failed with error")).not.toBeInTheDocument();
  });

  it("clears all notifications", async () => {
    const user = userEvent.setup();
    const clear = vi.fn();
    useNotificationStore.setState({
      notifications: [makeNotification({ id: "n1" })],
      clear,
    } as never);
    render(<OrchestrationFullView />);
    await user.click(screen.getByRole("button", { name: "通知" }));

    await user.click(screen.getByRole("button", { name: "清空" }));

    expect(clear).toHaveBeenCalledTimes(1);
  });
});

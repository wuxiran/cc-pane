import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OrchestratorTaskCard from "./OrchestratorTaskCard";
import { useOrchestratorStore } from "@/stores";
import type { TaskBinding } from "@/types";

vi.mock("@/services", () => ({
  localHistoryService: { getCurrentBranch: vi.fn(async () => undefined) },
  terminalService: {
    killIdempotent: vi.fn(async () => undefined),
    createSession: vi.fn(async () => "session-x"),
    submitToSession: vi.fn(async () => undefined),
  },
  taskBindingService: {
    query: vi.fn(async () => ({ items: [], total: 0, hasMore: false })),
  },
}));

let idCounter = 0;
function createBinding(overrides: Partial<TaskBinding> = {}): TaskBinding {
  idCounter += 1;
  const now = new Date().toISOString();
  return {
    id: `bind-${idCounter}`,
    title: `Task ${idCounter}`,
    role: "task",
    projectPath: "/repo/frontend",
    cliTool: "claude",
    status: "running",
    progress: 40,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const setSelectedTaskId = vi.fn();

function seedStore(bindings: TaskBinding[], selectedTaskId: string | null = null) {
  useOrchestratorStore.setState({
    bindings,
    selectedTaskId,
    setSelectedTaskId: setSelectedTaskId as never,
  });
}

describe("OrchestratorTaskCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedStore([]);
  });

  it("renders title, cli tool, project name and role marker", () => {
    const binding = createBinding({ title: "Implement login", role: "worker" });
    seedStore([binding]);

    const { container } = render(<OrchestratorTaskCard binding={binding} />);

    expect(screen.getByText("Implement login")).toBeVisible();
    expect(screen.getByText("claude")).toBeVisible();
    expect(screen.getByText("frontend")).toBeVisible();
    // worker role marker is an icon with a localized accessible name.
    expect(screen.getByRole("img", { name: "工作单元" })).toBeVisible();
    expect(container.querySelector('[data-cli-brand="claude"]')).not.toBeNull();
  });

  it("selects the task when the card is clicked", async () => {
    const user = userEvent.setup();
    const binding = createBinding();
    seedStore([binding]);

    render(<OrchestratorTaskCard binding={binding} />);
    await user.click(screen.getByText(binding.title));

    expect(setSelectedTaskId).toHaveBeenCalledWith(binding.id);
  });

  it("shows a leader shortcut when the task has a parent leader", () => {
    const leader = createBinding({ title: "Plan leader", role: "leader" });
    const worker = createBinding({ title: "Worker task", role: "worker", parentId: leader.id });
    seedStore([leader, worker]);

    render(<OrchestratorTaskCard binding={worker} />);

    expect(screen.getByRole("button", { name: "负责人: Plan leader" })).toBeVisible();
  });

  it("shows a workers badge counting child tasks", () => {
    const leader = createBinding({ title: "Leader", role: "leader" });
    const w1 = createBinding({ role: "worker", parentId: leader.id, status: "running" });
    const w2 = createBinding({ role: "worker", parentId: leader.id, status: "completed" });
    seedStore([leader, w1, w2]);

    render(<OrchestratorTaskCard binding={leader} />);

    expect(screen.getByText("2 个工作单元")).toBeVisible();
  });

  it("shows the progress bar only for running tasks", () => {
    const pending = createBinding({ status: "pending", progress: 0 });
    seedStore([pending]);
    const { container, rerender } = render(<OrchestratorTaskCard binding={pending} />);

    // No progress track for pending.
    expect(screen.queryByRole("progressbar")).toBeNull();

    const failed = createBinding({ status: "failed", progress: 30 });
    seedStore([failed]);
    rerender(<OrchestratorTaskCard binding={failed} />);
    expect(screen.queryByRole("progressbar")).toBeNull();

    const running = createBinding({ status: "running", progress: 55 });
    seedStore([running]);
    rerender(<OrchestratorTaskCard binding={running} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "55");
    const bar = container.querySelector('[style*="width: 55%"]');
    expect(bar).not.toBeNull();
  });

  it("renders the completion summary for a non-failed task", () => {
    const binding = createBinding({ status: "completed", completionSummary: "All tests passing" });
    seedStore([binding]);

    render(<OrchestratorTaskCard binding={binding} />);

    expect(screen.getByText("All tests passing")).toBeVisible();
    // Completed status is expressed once, as a localized status label.
    expect(screen.getByTestId("task-status")).toHaveTextContent("已完成");
  });

  it("expresses failure once and shows the exit code as secondary text", () => {
    const binding = createBinding({
      status: "failed",
      exitCode: 137,
      completionSummary: "Killed by user",
    });
    seedStore([binding]);

    render(<OrchestratorTaskCard binding={binding} />);

    expect(screen.getAllByTestId("task-status")).toHaveLength(1);
    expect(screen.getByTestId("task-status")).toHaveTextContent("失败");
    expect(screen.getByRole("button", { name: "退出码 137 · Killed by user" })).toBeVisible();
    expect(screen.queryByText(/Failed|❌/)).toBeNull();
  });

  it("shows the git branch and worktree marker from metadata", () => {
    const binding = createBinding({
      metadata: { ui: { gitBranch: "feature/login", isWorktree: true } },
    });
    seedStore([binding]);

    render(<OrchestratorTaskCard binding={binding} />);

    expect(screen.getByText("feature/login")).toBeVisible();
    expect(screen.getByRole("img", { name: "工作树" })).toBeInTheDocument();
    expect(screen.getByTestId("task-branch").textContent).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  it("is Tab-focusable and activates on Enter/Space", async () => {
    const user = userEvent.setup();
    const binding = createBinding({ title: "Keyboard task" });
    seedStore([binding]);

    const { container } = render(<OrchestratorTaskCard binding={binding} />);
    const card = container.firstElementChild as HTMLElement;

    expect(card).toHaveAttribute("role", "button");
    expect(card).toHaveAttribute("tabindex", "0");

    await user.tab();
    expect(card).toHaveFocus();

    fireEvent.keyDown(card, { key: "Enter" });
    expect(setSelectedTaskId).toHaveBeenCalledWith(binding.id);
    fireEvent.keyDown(card, { key: " " });
    expect(setSelectedTaskId).toHaveBeenCalledTimes(2);
  });
});

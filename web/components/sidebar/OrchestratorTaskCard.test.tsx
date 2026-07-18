import "@/i18n";
import { render, screen } from "@testing-library/react";
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

    render(<OrchestratorTaskCard binding={binding} />);

    expect(screen.getByText("Implement login")).toBeVisible();
    expect(screen.getByText("claude")).toBeVisible();
    expect(screen.getByText("frontend")).toBeVisible();
    // worker role marker carries a title of "worker".
    expect(screen.getByTitle("worker")).toBeVisible();
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

    expect(screen.getByText(/📋 负责人: Plan leader/)).toBeVisible();
  });

  it("shows a workers badge counting child tasks", () => {
    const leader = createBinding({ title: "Leader", role: "leader" });
    const w1 = createBinding({ role: "worker", parentId: leader.id, status: "running" });
    const w2 = createBinding({ role: "worker", parentId: leader.id, status: "completed" });
    seedStore([leader, w1, w2]);

    render(<OrchestratorTaskCard binding={leader} />);

    expect(screen.getByText(/⚙️ 2 个工作单元/)).toBeVisible();
  });

  it("hides the progress bar for pending tasks but shows it otherwise", () => {
    const pending = createBinding({ status: "pending", progress: 0 });
    seedStore([pending]);
    const { container, rerender } = render(<OrchestratorTaskCard binding={pending} />);

    // No progress track for pending.
    expect(container.querySelector('[style*="width"]')).toBeNull();

    const running = createBinding({ status: "running", progress: 55 });
    seedStore([running]);
    rerender(<OrchestratorTaskCard binding={running} />);
    const bar = container.querySelector('[style*="width: 55%"]');
    expect(bar).not.toBeNull();
  });

  it("renders the completion summary for a non-failed task", () => {
    const binding = createBinding({ status: "completed", completionSummary: "All tests passing" });
    seedStore([binding]);

    render(<OrchestratorTaskCard binding={binding} />);

    expect(screen.getByText("All tests passing")).toBeVisible();
    // Completed tasks render the localized "done" label instead of the relative time.
    expect(screen.getByText("已完成")).toBeVisible();
  });

  it("renders a failure button with the exit code for failed tasks", () => {
    const binding = createBinding({
      status: "failed",
      exitCode: 137,
      completionSummary: "Killed by user",
    });
    seedStore([binding]);

    render(<OrchestratorTaskCard binding={binding} />);

    expect(screen.getByText("失败")).toBeVisible();
    expect(screen.getByText(/退出码 137/)).toBeVisible();
  });

  it("shows the git branch and worktree marker from metadata", () => {
    const binding = createBinding({
      metadata: { ui: { gitBranch: "feature/login", isWorktree: true } },
    });
    seedStore([binding]);

    render(<OrchestratorTaskCard binding={binding} />);

    expect(screen.getByText(/🌿 feature\/login/)).toBeVisible();
    expect(screen.getByText("🌳")).toBeVisible();
  });

  it("indents nested tasks based on depth", () => {
    const binding = createBinding();
    seedStore([binding]);

    const { container } = render(<OrchestratorTaskCard binding={binding} depth={2} />);
    const card = container.firstElementChild as HTMLElement;

    // depth 2 -> marginLeft = min(2*14, 42) = 28px.
    expect(card.style.marginLeft).toBe("28px");
  });
});

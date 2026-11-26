import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OrchestratorTaskTree from "./OrchestratorTaskTree";
import { useOrchestratorStore } from "@/stores";
import type { TaskBinding } from "@/types";

// Render the card as a simple marker exposing title + depth so we can assert
// on the flattened/visible tree without pulling in the full card implementation.
vi.mock("./OrchestratorTaskCard", () => ({
  default: ({ binding, depth }: { binding: TaskBinding; depth?: number }) => (
    <div data-testid="card" data-depth={depth}>
      {binding.title}
    </div>
  ),
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

function setBindings(bindings: TaskBinding[]): void {
  useOrchestratorStore.setState({ bindings });
}

function renderLeaderWithWorker(): void {
  setBindings([
    makeBinding({ id: "leader", title: "Leader", role: "leader" }),
    makeBinding({ id: "worker", title: "Worker", role: "worker", parentId: "leader" }),
  ]);
  render(<OrchestratorTaskTree />);
}

describe("OrchestratorTaskTree", () => {
  beforeEach(() => {
    setBindings([]);
  });

  it("renders nothing when there are no bindings", () => {
    render(<OrchestratorTaskTree />);
    expect(screen.queryAllByTestId("card")).toHaveLength(0);
  });

  it("renders parent and child cards with increasing depth by default", () => {
    renderLeaderWithWorker();

    const cards = screen.getAllByTestId("card");
    expect(cards.map((c) => c.textContent)).toEqual(["Leader", "Worker"]);
    expect(cards[0].getAttribute("data-depth")).toBe("0");
    expect(cards[1].getAttribute("data-depth")).toBe("1");
  });

  it("marks worker children with a connector in the gutter instead of an overlay badge", () => {
    renderLeaderWithWorker();
    const rows = screen.getAllByTestId("task-tree-row");
    expect(rows.map((row) => row.getAttribute("data-role"))).toEqual(["leader", "worker"]);
    expect(rows[1].querySelector('[data-testid="tree-child-connector"]')).not.toBeNull();
    expect(screen.queryByText(/↪/)).not.toBeInTheDocument();
  });

  it("collapses and re-expands children via the parent's toggle", () => {
    renderLeaderWithWorker();

    expect(screen.getByText("Worker")).toBeInTheDocument();
    // parent has children → its toggle title is "折叠" while expanded
    fireEvent.click(screen.getByRole("button", { name: "折叠" }));

    expect(screen.queryByText("Worker")).not.toBeInTheDocument();
    expect(screen.getByText("Leader")).toBeInTheDocument();
    // toggle now offers "展开"
    // toggle again re-expands
    fireEvent.click(screen.getByRole("button", { name: "展开" }));
    expect(screen.getByText("Worker")).toBeInTheDocument();
  });

  it("does not render a collapse toggle for leaf root nodes", () => {
    setBindings([makeBinding({ id: "solo", title: "Solo" })]);
    render(<OrchestratorTaskTree />);
    expect(screen.queryByRole("button", { name: "折叠" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "展开" })).not.toBeInTheDocument();
  });
});

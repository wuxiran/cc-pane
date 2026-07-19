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

describe("OrchestratorTaskTree", () => {
  beforeEach(() => {
    setBindings([]);
  });

  it("renders nothing when there are no bindings", () => {
    render(<OrchestratorTaskTree />);
    expect(screen.queryAllByTestId("card")).toHaveLength(0);
  });

  it("renders parent and child cards with increasing depth by default", () => {
    setBindings([
      makeBinding({ id: "leader", title: "Leader", role: "leader" }),
      makeBinding({ id: "worker", title: "Worker", role: "worker", parentId: "leader" }),
    ]);
    render(<OrchestratorTaskTree />);

    const cards = screen.getAllByTestId("card");
    expect(cards.map((c) => c.textContent)).toEqual(["Leader", "Worker"]);
    expect(cards[0].getAttribute("data-depth")).toBe("0");
    expect(cards[1].getAttribute("data-depth")).toBe("1");
  });

  it("shows a worker badge for worker-role nodes", () => {
    setBindings([
      makeBinding({ id: "leader", title: "Leader", role: "leader" }),
      makeBinding({ id: "worker", title: "Worker", role: "worker", parentId: "leader" }),
    ]);
    render(<OrchestratorTaskTree />);
    expect(screen.getByText("↪ worker")).toBeVisible();
  });

  it("collapses children when clicking the parent's collapse toggle", () => {
    setBindings([
      makeBinding({ id: "leader", title: "Leader", role: "leader" }),
      makeBinding({ id: "worker", title: "Worker", role: "worker", parentId: "leader" }),
    ]);
    render(<OrchestratorTaskTree />);

    expect(screen.getByText("Worker")).toBeInTheDocument();
    // parent has children → its toggle title is "折叠" while expanded
    fireEvent.click(screen.getByTitle("折叠"));

    expect(screen.queryByText("Worker")).not.toBeInTheDocument();
    expect(screen.getByText("Leader")).toBeInTheDocument();
    // toggle now offers "展开"
    expect(screen.getByTitle("展开")).toBeVisible();
  });

  it("re-expands children when clicking the toggle again", () => {
    setBindings([
      makeBinding({ id: "leader", title: "Leader", role: "leader" }),
      makeBinding({ id: "worker", title: "Worker", role: "worker", parentId: "leader" }),
    ]);
    render(<OrchestratorTaskTree />);

    fireEvent.click(screen.getByTitle("折叠"));
    expect(screen.queryByText("Worker")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle("展开"));
    expect(screen.getByText("Worker")).toBeInTheDocument();
  });

  it("does not render a collapse toggle for leaf root nodes", () => {
    setBindings([makeBinding({ id: "solo", title: "Solo" })]);
    render(<OrchestratorTaskTree />);
    expect(screen.queryByTitle("折叠")).not.toBeInTheDocument();
    expect(screen.queryByTitle("展开")).not.toBeInTheDocument();
  });
});

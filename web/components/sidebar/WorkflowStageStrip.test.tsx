import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WorkflowStageStrip from "./WorkflowStageStrip";
import { useWorkflowStore } from "@/stores";
import type { Workflow } from "@/types";

const approveStage = vi.fn();
vi.mock("@/services/workflowService", () => ({
  workflowService: {
    list: vi.fn(async () => []),
    approveStage: (...args: unknown[]) => approveStage(...args),
  },
}));

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf",
    status: "waiting_approval",
    pools: {},
    createdAt: "t0",
    updatedAt: "t0",
    stages: [
      {
        index: 0,
        key: "plan",
        requiresApproval: false,
        status: "done",
        tasks: [{ key: "a", pool: "claude", status: "done" }],
      },
      {
        index: 1,
        key: "impl",
        requiresApproval: true,
        status: "waiting_approval",
        tasks: [
          { key: "rust", pool: "codex", status: "pending" },
          { key: "ts", pool: "claude", status: "pending" },
        ],
      },
    ],
    ...overrides,
  };
}

describe("WorkflowStageStrip", () => {
  beforeEach(() => {
    approveStage.mockReset();
    useWorkflowStore.setState({ byId: {}, approving: {}, error: null });
  });

  it("shows every stage with progress and an approve button only where approval is pending", () => {
    render(<WorkflowStageStrip workflow={workflow()} />);
    const stages = screen.getAllByTestId("workflow-stage");
    expect(stages.map((stage) => stage.getAttribute("data-status"))).toEqual(["done", "waiting_approval"]);
    expect(stages[0].textContent).toContain("1/1");
    expect(stages[1].textContent).toContain("0/2");
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("approves through the store and stores the returned workflow", async () => {
    const approved = workflow({ status: "running" });
    approved.stages[1] = { ...approved.stages[1], status: "running", approvedAt: "t1" };
    approveStage.mockResolvedValue(approved);
    render(<WorkflowStageStrip workflow={workflow()} />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(useWorkflowStore.getState().byId.wf?.status).toBe("running"));
    expect(approveStage).toHaveBeenCalledWith("wf", 1);
  });

  it("keeps the error when approval fails", async () => {
    approveStage.mockRejectedValue(new Error("stage 'impl' is running"));
    render(<WorkflowStageStrip workflow={workflow()} />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(useWorkflowStore.getState().error).toContain("running"));
    expect(useWorkflowStore.getState().approving).toEqual({});
  });
});

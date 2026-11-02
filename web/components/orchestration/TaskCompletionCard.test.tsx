import "@/i18n";
import "@/i18n/taskVerificationResources";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { taskVerificationService } from "@/services/taskVerificationService";
import type { TaskCompletionReport, TaskVerificationReport } from "@/types/taskVerification";
import TaskCompletionCard from "./TaskCompletionCard";

vi.mock("@/services/taskVerificationService", () => ({ taskVerificationService: { setCriteria: vi.fn(), accept: vi.fn() } }));

function completion(overrides: Partial<TaskCompletionReport> = {}): TaskCompletionReport {
  return {
    criteria: { definitionOfDone: "Behavior matches", requiredCommands: ["npm test"] },
    criteriaRevision: 2, reportRevision: 5, codeFingerprint: "code", agentFinished: true, checksStatus: "missing",
    checks: [{ command: "npm test", evidenceId: null, status: "missing" }],
    acceptance: null, userAccepted: false, canAccept: false, ...overrides,
  };
}

function report(value: TaskCompletionReport): TaskVerificationReport {
  return { taskId: "task", cwd: "/repo", currentFingerprint: "code", snapshotError: null,
    running: false, evidence: [], completion: value };
}

beforeEach(() => vi.resetAllMocks());

describe("TaskCompletionCard", () => {
  it("keeps agent finish, checks and user acceptance distinct and disables blocked acceptance", () => {
    render(<TaskCompletionCard taskId="task" completion={completion()} checking={false} onReport={vi.fn()} onRun={vi.fn()} />);
    expect(screen.getByText("✓ Agent 已结束")).toBeInTheDocument();
    expect(screen.getByText("○ 用户验收")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "验收当前结果" })).toBeDisabled();
    expect(taskVerificationService.accept).not.toHaveBeenCalled();
  });

  it("requires an explicit click and sends the reviewed task and policy revisions", async () => {
    const user = userEvent.setup();
    const value = completion({ checksStatus: "passed", canAccept: true });
    const next = report({ ...value, userAccepted: true });
    vi.mocked(taskVerificationService.accept).mockResolvedValue(next);
    const onReport = vi.fn();
    render(<TaskCompletionCard taskId="task" completion={value} checking={false} onReport={onReport} onRun={vi.fn()} />);
    expect(taskVerificationService.accept).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("验收备注（选填）"), "Reviewed the screenshot");
    await user.click(screen.getByRole("button", { name: "验收当前结果" }));
    expect(taskVerificationService.accept).toHaveBeenCalledWith("task", {
      expectedCriteriaRevision: 2, expectedReportRevision: 5, expectedFingerprint: "code", expectedEvidenceIds: [], note: "Reviewed the screenshot",
    });
    expect(onReport).toHaveBeenCalledWith(next);
  });

  it("blocks acceptance while code is refreshing even if an old response was accepted", () => {
    render(<TaskCompletionCard taskId="task" completion={completion({ checksStatus: "passed", canAccept: true, userAccepted: true,
      acceptance: { acceptedAt: "2026-10-22T01:00:00Z", criteriaRevision: 2, reportRevision: 5, fingerprint: "code", evidenceIds: ["id"], note: "" },
    })} checking onReport={vi.fn()} onRun={vi.fn()} />);
    expect(screen.getByText("○ 用户验收")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "验收当前结果" })).toBeDisabled();
    expect(screen.queryByText("✓ 用户验收")).not.toBeInTheDocument();
  });

  it("saves criteria and never executes a required command merely by saving", async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    vi.mocked(taskVerificationService.setCriteria).mockResolvedValue(report(completion({ criteriaRevision: 3 })));
    render(<TaskCompletionCard taskId="task" completion={completion({ canAccept: true })} checking={false} onReport={vi.fn()} onRun={onRun} />);
    fireEvent.click(screen.getByText("完成条件"));
    fireEvent.change(screen.getByLabelText("必需检查命令（每行一条）"), { target: { value: "npm test\nnpm run lint" } });
    expect(screen.getByRole("button", { name: "验收当前结果" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "保存完成条件" }));
    expect(taskVerificationService.setCriteria).toHaveBeenCalledWith("task", {
      expectedRevision: 2, criteria: { definitionOfDone: "Behavior matches", requiredCommands: ["npm test", "npm run lint"] },
    });
    expect(onRun).not.toHaveBeenCalled();
  });

  it("runs the selected required command through the existing evidence runner", async () => {
    const onRun = vi.fn();
    render(<TaskCompletionCard taskId="task" completion={completion()} checking={false} onReport={vi.fn()} onRun={onRun} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "运行此检查" }));
    expect(onRun).toHaveBeenCalledWith("npm test");
  });

  it("shows manual acceptance without inventing an automated pass", () => {
    render(<TaskCompletionCard taskId="task" completion={completion({
      criteria: { definitionOfDone: "Review", requiredCommands: [] }, checksStatus: "not_configured", checks: [], canAccept: true,
    })} checking={false} onReport={vi.fn()} onRun={vi.fn()} />);
    expect(screen.getByText(/手动验收只记录你的审阅/)).toBeInTheDocument();
    expect(screen.getByText(/○ 检查通过: 未配置/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "验收当前结果" })).toBeEnabled();
  });

  it("surfaces stale acceptance rejection from the backend", async () => {
    vi.mocked(taskVerificationService.accept).mockRejectedValue(new Error("Evidence changed; rerun"));
    render(<TaskCompletionCard taskId="task" completion={completion({ canAccept: true })} checking={false} onReport={vi.fn()} onRun={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "验收当前结果" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Evidence changed; rerun");
    expect(screen.queryByText("✓ 用户验收")).not.toBeInTheDocument();
  });
});

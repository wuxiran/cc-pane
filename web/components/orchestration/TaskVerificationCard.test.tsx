import "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { taskVerificationService } from "@/services/taskVerificationService";
import type { TaskVerificationEvidence, TaskVerificationReport } from "@/types/taskVerification";
import TaskVerificationCard from "./TaskVerificationCard";

vi.mock("@/services/taskVerificationService", () => ({
  taskVerificationService: { list: vi.fn(), run: vi.fn() },
}));

function evidence(overrides: Partial<TaskVerificationEvidence> = {}): TaskVerificationEvidence {
  return {
    id: "check-1", taskId: "task-1", command: "npm test", cwd: "/repo",
    startedAt: "2026-10-19T09:00:00Z", completedAt: "2026-10-19T09:00:01Z",
    durationMs: 1000, timeoutSecs: 300, exitCode: 0, signal: null, timedOut: false,
    stdout: "real command output", stderr: "", outputTruncated: false,
    executionError: null, originalHead: "abc123", originalFingerprint: "original", finalFingerprint: "original",
    codeChangedDuringRun: false, observationError: null, freshness: "current", ...overrides,
  };
}

function report(items: TaskVerificationEvidence[] = []): TaskVerificationReport {
  return { taskId: "task-1", cwd: "/repo", currentFingerprint: "original",
    snapshotError: null, running: false, evidence: items };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(taskVerificationService.list).mockResolvedValue(report());
});

describe("TaskVerificationCard", () => {
  it("runs only after explicit action and renders independent successful and failed evidence", async () => {
    const user = userEvent.setup();
    render(<TaskVerificationCard taskId="task-1" />);
    await screen.findByText("尚无检查结果。任务完成不代表验收已通过。");
    expect(taskVerificationService.run).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("检查命令"), "npm test");
    const next = report([evidence(), evidence({ id: "check-2", command: "npm run lint", exitCode: 2, stderr: "lint error" })]);
    vi.mocked(taskVerificationService.run).mockResolvedValue(next);
    vi.mocked(taskVerificationService.list).mockResolvedValue(next);
    await user.click(screen.getByRole("button", { name: "运行检查" }));
    expect(taskVerificationService.run).toHaveBeenCalledWith("task-1", { command: "npm test", timeoutSecs: 300 });
    await screen.findByText("通过 · 当前代码");
    expect(screen.getByText("检查失败")).toBeInTheDocument();
    expect(screen.getByText("退出码: 2")).toBeInTheDocument();
    expect(screen.getAllByText("real command output")).toHaveLength(2);
  });

  it("never presents stale, changed-during-run or unknown evidence as current passes", async () => {
    vi.mocked(taskVerificationService.list).mockResolvedValue(report([
      evidence({ freshness: "current", codeChangedDuringRun: true }),
      evidence({ id: "unknown", freshness: "unknown", observationError: "snapshot unavailable" }),
    ]));
    render(<TaskVerificationCard taskId="task-1" />);
    await screen.findByText("证据已过期 · 需要重跑");
    expect(screen.getByText("代码状态未知 · 未验证")).toBeInTheDocument();
    expect(screen.queryByText("通过 · 当前代码")).not.toBeInTheDocument();
    expect(screen.getByText("检查期间代码发生变化，此结果不能验证当前代码。")).toBeInTheDocument();
  });

  it("invalidates displayed passes when freshness refresh fails", async () => {
    vi.mocked(taskVerificationService.list).mockResolvedValue(report([evidence()]));
    render(<TaskVerificationCard taskId="task-1" />);
    await screen.findByText("通过 · 当前代码");
    vi.mocked(taskVerificationService.list).mockRejectedValue(new Error("repository unavailable"));
    fireEvent.focus(window);
    await screen.findByRole("alert");
    expect(screen.queryByText("通过 · 当前代码")).not.toBeInTheDocument();
    expect(screen.getByText("代码状态未知 · 未验证")).toBeInTheDocument();
  });

  it("withholds green while a freshness refresh is still pending", async () => {
    vi.mocked(taskVerificationService.list).mockResolvedValue(report([evidence()]));
    render(<TaskVerificationCard taskId="task-1" />);
    await screen.findByText("通过 · 当前代码");
    let resolve!: (value: TaskVerificationReport) => void;
    vi.mocked(taskVerificationService.list).mockReturnValue(new Promise((done) => { resolve = done; }));
    fireEvent.focus(window);
    await screen.findByText("代码状态未知 · 未验证");
    expect(screen.queryByText("通过 · 当前代码")).not.toBeInTheDocument();
    await act(async () => { resolve(report([evidence({ freshness: "stale" })])); });
    await screen.findByText("证据已过期 · 需要重跑");
  });

  it("withholds green during an explicitly started check", async () => {
    const user = userEvent.setup();
    vi.mocked(taskVerificationService.list).mockResolvedValue(report([evidence()]));
    let resolve!: (value: TaskVerificationReport) => void;
    vi.mocked(taskVerificationService.run).mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<TaskVerificationCard taskId="task-1" />);
    await screen.findByText("通过 · 当前代码");
    await user.type(screen.getByLabelText("检查命令"), "npm test");
    await user.click(screen.getByRole("button", { name: "运行检查" }));
    await screen.findByText("代码状态未知 · 未验证");
    expect(screen.queryByText("通过 · 当前代码")).not.toBeInTheDocument();
    await act(async () => { resolve(report([evidence()])); });
  });

  it.each([
    { name: "original fingerprint differs", result: report([evidence({ originalFingerprint: "older" })]) },
    { name: "final fingerprint differs", result: report([evidence({ finalFingerprint: "other" })]) },
    { name: "missing current fingerprint", result: { ...report([evidence()]), currentFingerprint: null } },
    { name: "unknown freshness value", result: report([evidence({ freshness: "future" as TaskVerificationEvidence["freshness"] })]) },
    { name: "another check is running", result: { ...report([evidence()]), running: true } },
    { name: "snapshot observation failed", result: { ...report([evidence()]), snapshotError: "snapshot unavailable" } },
  ])("never shows green when $name", async ({ result }) => {
    vi.mocked(taskVerificationService.list).mockResolvedValue(result);
    render(<TaskVerificationCard taskId="task-1" />);
    await screen.findByText("代码状态未知 · 未验证");
    expect(screen.queryByText("通过 · 当前代码")).not.toBeInTheDocument();
  });

  it("never shows green for a failed, timed-out, signalled or unobserved check", async () => {
    vi.mocked(taskVerificationService.list).mockResolvedValue(report([
      evidence({ id: "exit", exitCode: 3 }),
      evidence({ id: "timeout", timedOut: true }),
      evidence({ id: "signal", signal: 9 }),
      evidence({ id: "execution", executionError: "cleanup incomplete" }),
      evidence({ id: "observation", observationError: "watcher unavailable" }),
    ]));
    render(<TaskVerificationCard taskId="task-1" />);
    await screen.findByText("检查超时");
    expect(screen.queryByText("通过 · 当前代码")).not.toBeInTheDocument();
    expect(screen.getAllByText("检查失败")).toHaveLength(3);
    expect(screen.getByText("代码状态未知 · 未验证")).toBeInTheDocument();
  });

  it("lets an explicit check finish without refreshing an unmounted task card", async () => {
    const user = userEvent.setup();
    let resolve!: (value: TaskVerificationReport) => void;
    vi.mocked(taskVerificationService.run).mockReturnValue(new Promise((done) => { resolve = done; }));
    const view = render(<TaskVerificationCard taskId="task-1" />);
    await screen.findByText("尚无检查结果。任务完成不代表验收已通过。");
    await user.type(screen.getByLabelText("检查命令"), "npm test");
    await user.click(screen.getByRole("button", { name: "运行检查" }));
    view.unmount();
    await act(async () => { resolve(report([evidence()])); });
    expect(taskVerificationService.list).toHaveBeenCalledTimes(1);
  });

  it("does not clobber another task with an earlier task's delayed response", async () => {
    let resolve!: (value: TaskVerificationReport) => void;
    vi.mocked(taskVerificationService.list).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const view = render(<TaskVerificationCard taskId="task-1" />);
    view.rerender(<TaskVerificationCard taskId="task-2" />);
    await waitFor(() => expect(taskVerificationService.list).toHaveBeenCalledWith("task-2"));
    await act(async () => { resolve(report([evidence()])); });
    expect(screen.queryByText("npm test", { selector: "code" })).not.toBeInTheDocument();
  });
});

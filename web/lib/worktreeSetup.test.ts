import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeSetupPlan } from "@/services";

const prepareSetup = vi.fn();
const submitToSession = vi.fn();
const addTab = vi.fn();
const waitForTabSession = vi.fn();
const isTauri = vi.fn(() => true);

vi.mock("@/services", () => ({
  worktreeService: { prepareSetup: (...args: unknown[]) => prepareSetup(...args) },
  terminalService: { submitToSession: (...args: unknown[]) => submitToSession(...args) },
}));
vi.mock("@/utils", () => ({ handleErrorSilent: vi.fn() }));
vi.mock("@/services/runtime", () => ({ isTauriRuntime: () => isTauri() }));
vi.mock("@/stores/usePanesStore", () => ({
  usePanesStore: { getState: () => ({ activePaneId: "pane-1", addTab }) },
}));
vi.mock("@/lib/quickCommandExecution", () => ({
  waitForTabSession: (...args: unknown[]) => waitForTabSession(...args),
}));

import { requestWorktreeSetup, worktreeSetupAction } from "./worktreeSetup";
import { useWorktreeSetupStore } from "@/stores/useWorktreeSetupStore";

function plan(overrides: Partial<WorktreeSetupPlan> = {}): WorktreeSetupPlan {
  return {
    projectPath: "/repo",
    worktreePath: "/repo-worktrees/a",
    setup: ["npm ci"],
    commandLine: "npm ci",
    configHash: "h".repeat(64),
    alwaysAllowed: false,
    copiedFiles: [],
    sparseApplied: false,
    warnings: [],
    ...overrides,
  };
}

describe("worktreeSetupAction", () => {
  it("没有配置或没有命令时不做事", () => {
    expect(worktreeSetupAction(null)).toBe("none");
    expect(worktreeSetupAction(plan({ setup: [], commandLine: "" }))).toBe("none");
  });

  it("未批准要确认，已批准直接执行", () => {
    expect(worktreeSetupAction(plan())).toBe("confirm");
    expect(worktreeSetupAction(plan({ alwaysAllowed: true }))).toBe("run");
  });
});

describe("requestWorktreeSetup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isTauri.mockReturnValue(true);
    useWorktreeSetupStore.setState({ queue: [] });
    waitForTabSession.mockResolvedValue("session-1");
  });

  it("未批准时排队等确认，不开终端", async () => {
    prepareSetup.mockResolvedValue(plan());
    await requestWorktreeSetup("/repo-worktrees/a");
    expect(useWorktreeSetupStore.getState().queue).toHaveLength(1);
    expect(addTab).not.toHaveBeenCalled();
  });

  it("已「始终允许」时在新终端标签里以 worktree 为 cwd 执行", async () => {
    prepareSetup.mockResolvedValue(plan({ alwaysAllowed: true, commandLine: "npm ci && make" }));
    await requestWorktreeSetup("/repo-worktrees/a");
    expect(addTab).toHaveBeenCalledWith(
      "pane-1",
      expect.objectContaining({ projectPath: "/repo-worktrees/a", cliTool: "none" }),
    );
    expect(submitToSession).toHaveBeenCalledWith("session-1", "npm ci && make");
    expect(useWorktreeSetupStore.getState().queue).toHaveLength(0);
  });

  it("Web 模式与 prepare 失败都静默跳过", async () => {
    isTauri.mockReturnValue(false);
    await requestWorktreeSetup("/x");
    expect(prepareSetup).not.toHaveBeenCalled();
    isTauri.mockReturnValue(true);
    prepareSetup.mockRejectedValue(new Error("boom"));
    await expect(requestWorktreeSetup("/x")).resolves.toBeUndefined();
  });

  it("同一个 worktree 不重复排队", () => {
    const store = useWorktreeSetupStore.getState();
    store.enqueue(plan());
    store.enqueue(plan());
    expect(useWorktreeSetupStore.getState().queue).toHaveLength(1);
    useWorktreeSetupStore.getState().shift();
    expect(useWorktreeSetupStore.getState().queue).toHaveLength(0);
  });
});

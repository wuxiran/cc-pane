import { buildTerminalFork } from "./chatForkLaunch";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Tab } from "@/types";
import { supportsAcpFork, terminalForkSource } from "./chatForkService";
import { forkReviewService } from "./forkReviewService";
vi.mock("./forkReviewService", () => ({
  forkReviewService: { prepare: vi.fn() },
}));
const tab = (): Tab => ({
  id: "parent",
  title: "source",
  contentType: "terminal",
  projectId: "p",
  projectPath: "/repo",
  sessionId: "parent-pty",
  resumeId: "parent-conversation",
  cliTool: "codex",
  launchExtras: {
    initialPrompt: "already sent",
    adapterOptions: { effort: "high" },
  },
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(forkReviewService.prepare).mockImplementation(async ({ cwd }) => ({ cwd, record: null }));
});
describe("chat fork launch", () => {
  it("creates an independent identity and preserves configuration without replaying the prompt", async () => {
    const parent = tab();
    const child = await buildTerminalFork(parent, "same-directory");
    expect(child.resumeId).toBeUndefined();
    expect(child.sessionId).toBeUndefined();
    expect(child.launchExtras?.initialPrompt).toBeUndefined();
    expect(child.launchExtras?.adapterOptions).toEqual({
      effort: "high",
      forkSessionId: "parent-conversation",
      forkCwd: "/repo",
    });
    expect(child.projectId).not.toBe(parent.projectId);
    expect(parent.resumeId).toBe("parent-conversation");
    expect(forkReviewService.prepare).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/repo", mode: "same-directory", sourceTabId: parent.id,
      childTabId: child.tabId, sourceSessionId: parent.resumeId,
    }));
    expect(child.tabId).not.toBe(parent.id);
  });
  it("uses the active split conversation rather than its sibling", () => {
    const parent = tab();
    parent.activeTerminalPaneId = "leaf";
    parent.terminalRootPane = {
      type: "leaf",
      id: "leaf",
      sessionId: "leaf-pty",
      resumeId: "leaf-conversation",
      cliTool: "claude",
    };
    expect(terminalForkSource(parent)?.resumeId).toBe("leaf-conversation");
  });
  it("worktree changes cwd and clears the source workspace execution path", async () => {
    vi.mocked(forkReviewService.prepare).mockResolvedValue({ cwd: "/repo-worktrees/fork/sub", record: { id: "review-1" } as never });
    const parent = tab();
    parent.workspacePath = "/repo/sub";
    const child = await buildTerminalFork(parent, "worktree");
    expect(forkReviewService.prepare).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo/sub", mode: "worktree" }));
    expect(child.forkReviewId).toBe("review-1");
    expect(child.projectPath).toBe("/repo-worktrees/fork/sub");
    expect(child.workspacePath).toBeUndefined();
    expect(child.launchExtras?.launchCwd).toBe(child.projectPath);
  });
  it("keeps same-directory WSL forks on the distro without host snapshots", async () => {
    const parent = tab();
    parent.wsl = { distro: "Ubuntu" } as Tab["wsl"];
    const child = await buildTerminalFork(parent, "same-directory");
    expect(child.forkReviewId).toBeUndefined();
    expect(forkReviewService.prepare).not.toHaveBeenCalled();
    await expect(buildTerminalFork(parent, "worktree")).rejects.toThrow("WSL");
  });
  it("rejects unsupported or unidentified conversations", async () => {
    const parent = tab();
    parent.resumeId = undefined;
    expect(terminalForkSource(parent)).toBeNull();
    await expect(buildTerminalFork(parent, "same-directory")).rejects.toThrow();
  });
  it("does not claim resume-only ACP agents support forks", () => {
    expect(supportsAcpFork({ loadSession: true })).toBe(false);
    expect(supportsAcpFork({ sessionCapabilities: { fork: null } })).toBe(
      false,
    );
    expect(supportsAcpFork({ sessionCapabilities: { fork: {} } })).toBe(true);
  });
});

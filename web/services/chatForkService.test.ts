import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Tab } from "@/types";
import {
  buildTerminalFork,
  supportsAcpFork,
  terminalForkSource,
} from "./chatForkService";
import { worktreeService } from "./worktreeService";
vi.mock("./worktreeService", () => ({
  worktreeService: { forkChat: vi.fn() },
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
beforeEach(() => vi.clearAllMocks());
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
    expect(worktreeService.forkChat).not.toHaveBeenCalled();
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
    vi.mocked(worktreeService.forkChat).mockResolvedValue(
      "/repo-worktrees/fork/sub",
    );
    const parent = tab();
    parent.workspacePath = "/repo/sub";
    const child = await buildTerminalFork(parent, "worktree");
    expect(worktreeService.forkChat).toHaveBeenCalledWith("/repo/sub");
    expect(child.projectPath).toBe("/repo-worktrees/fork/sub");
    expect(child.workspacePath).toBeUndefined();
    expect(child.launchExtras?.launchCwd).toBe(child.projectPath);
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

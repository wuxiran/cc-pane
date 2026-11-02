import { describe, expect, it } from "vitest";
import type { Tab } from "@/types";
import { codexEngineLabel, codexOpenTarget, isCodexThreadId, isLocalCodexPath } from "./codexIntegration";

const terminal: Tab = { id: "cli", title: "Codex", contentType: "terminal", projectId: "", projectPath: "/project", sessionId: "pty", cliTool: "codex" };

describe("Codex target provenance", () => {
  it("uses a confirmed CLI resume ID and the active leaf's actual cwd", () => {
    expect(codexOpenTarget({ ...terminal, resumeId: "wrong-tab-id", resumeIdSource: "hook", activeTerminalPaneId: "active", terminalRootPane: {
      type: "leaf", id: "active", sessionId: "pty", cliTool: "codex", resumeId: "native-thread-id", resumeIdSource: "hook",
      launchExtras: { launchCwd: "/worktree/task" }, workspacePath: "/workspace",
    } })).toEqual({ cwd: "/worktree/task", threadId: "native-thread-id" });
  });

  it.each([undefined, "manual", "issued"])("falls back to a new conversation for unverified CLI identity %s", (resumeIdSource) => {
    expect(codexOpenTarget({ ...terminal, resumeId: "unverified", resumeIdSource })).toEqual({ cwd: "/project" });
  });

  it("never treats an ACP session ID as a native thread", () => {
    const tab = { ...terminal, contentType: "agent-chat" as const };
    expect(codexOpenTarget(tab, { chatId: tab.id, engineId: "codex", phase: "ready", acpSessionId: "acp-session", codexThreadId: "not-native" }, "/adopted"))
      .toEqual({ cwd: "/adopted" });
    expect(codexOpenTarget(tab, { chatId: tab.id, engineId: "codex-app-server", phase: "ready", acpSessionId: "transport-id", codexThreadId: "native-thread" }))
      .toEqual({ cwd: "/project", threadId: "native-thread" });
    expect(codexOpenTarget(tab, { chatId: tab.id, engineId: "codex-app-server", phase: "ready", acpSessionId: "transport-id" }))
      .toEqual({ cwd: "/project" });
  });

  it("rejects remote terminals, other engines and malformed identifiers", () => {
    expect(codexOpenTarget({ ...terminal, ssh: {} as Tab["ssh"] })).toBeNull();
    expect(codexOpenTarget({ ...terminal, wsl: { remotePath: "/project" } })).toBeNull();
    expect(codexOpenTarget({ ...terminal, cliTool: "claude" })).toBeNull();
    expect(codexOpenTarget({ ...terminal, projectPath: "relative" })).toBeNull();
    for (const id of ["new", "../thread", "native?x=y", "codex://threads/id", "bad\nthread"]) expect(isCodexThreadId(id)).toBe(false);
    expect(isLocalCodexPath("C:\\project\\nested")).toBe(true);
    expect(isLocalCodexPath("\\\\server\\share")).toBe(false);
    expect(isLocalCodexPath("//server/share")).toBe(false);
    expect(isLocalCodexPath("/project\n")).toBe(false);
  });

  it("labels native and ACP separately", () => {
    expect(codexEngineLabel("codex")).toBe("Codex (ACP)");
    expect(codexEngineLabel("codex-app-server")).toBe("Codex App Server");
    expect(codexEngineLabel("claude", "Claude Code")).toBe("Claude Code");
  });
});

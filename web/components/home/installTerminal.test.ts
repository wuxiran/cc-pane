import { describe, expect, it, vi } from "vitest";

const { setAppViewMode } = vi.hoisted(() => ({ setAppViewMode: vi.fn() }));
const state = vi.hoisted(() => ({
  tabs: [{ id: "old", contentType: "terminal", sessionId: "s-old" }] as Array<{ id: string; contentType: string; sessionId: string | null }>,
  outputCalls: 0,
}));

vi.mock("@/stores", () => ({
  useActivityBarStore: { getState: () => ({ setAppViewMode }) },
  usePanesStore: {
    getState: () => ({
      findTabAcrossLayouts: (id: string) => {
        const tab = state.tabs.find((candidate) => candidate.id === id);
        return tab ? { tab } : null;
      },
    }),
  },
}));
vi.mock("@/stores/paneLayoutHelpers", () => ({
  eachLayoutTree: (_state: unknown, fn: (layout: unknown, tree: unknown) => void) => fn({}, {}),
}));
vi.mock("@/lib/paneSessions", () => ({
  collectTabs: () => state.tabs,
  collectTerminalSessionIds: (tab: { sessionId: string | null }) => (tab.sessionId ? [tab.sessionId] : []),
}));
const submitToSession = vi.fn(async () => undefined);
vi.mock("@/services", () => ({
  terminalService: {
    getRecentOutput: vi.fn(async () => {
      state.outputCalls += 1;
      return { sessionId: "s-new", lines: state.outputCalls > 1 ? ["user@mac ~ %"] : [] };
    }),
    submitToSession: (...args: unknown[]) => submitToSession(...(args as [])),
  },
}));

import { runCommandInNewTerminal } from "./installTerminal";

describe("runCommandInNewTerminal", () => {
  it("认出新开的终端标签，等会话和提示符就绪后提交命令", async () => {
    const tab = { id: "new", contentType: "terminal", sessionId: null as string | null };
    const result = runCommandInNewTerminal(() => {
      state.tabs.push(tab);
      setTimeout(() => (tab.sessionId = "s-new"), 50);
    }, "npm install -g @openai/codex");
    expect(await result).toBe("sent");
    expect(submitToSession).toHaveBeenCalledWith("s-new", "npm install -g @openai/codex");
    // 首页上点的：必须切到分屏视图，否则 TerminalView 不挂载、会话永远起不来。
    expect(setAppViewMode).toHaveBeenCalledWith("panes");
  });
});

import { describe, expect, it } from "vitest";
import type { AgentChatSessionState, PendingChatPermission } from "@/stores/useAgentChatStore";
import type { TabAcrossLayoutsLocation } from "@/stores/panesStoreTypes";
import type { SessionCostEntry } from "@/stores/useSessionCostStore";
import type { Tab, TerminalStatusInfo } from "@/types";
import {
  collectChatSources,
  collectTerminalSources,
  engineLabel,
  pickQuota,
  toIslandApproval,
} from "./collectIslandSources";

const tab = (patch: Partial<Tab>): Tab => ({
  id: "tab-1",
  title: "bot-fix",
  contentType: "terminal",
  projectId: "p",
  projectPath: "/work/bot-fix",
  sessionId: "s1",
  ...patch,
});

const location = (value: Tab): TabAcrossLayoutsLocation =>
  ({ layoutId: "l", layoutName: "L", tree: {} as never, panel: { id: "panel" } as never, tab: value });

const status = (sessionId: string, patch: Partial<TerminalStatusInfo> = {}): [string, TerminalStatusInfo] => [
  sessionId,
  { sessionId, status: "toolRunning", lastOutputAt: 0, updatedAt: 0, ...patch },
];

const permission = (patch: Partial<PendingChatPermission> = {}): PendingChatPermission => ({
  requestKey: "req-1",
  params: {
    toolCall: { title: "想要运行一个命令", rawInput: { command: "npm run tauri:dev" } },
    options: [
      { optionId: "once", name: "批准一次", kind: "allow_once" },
      { optionId: "always", name: "总是允许 npm run", kind: "allow_always" },
      { optionId: "no", name: "拒绝", kind: "reject_once" },
    ],
  },
  responding: false,
  error: null,
  ...patch,
});

describe("collectTerminalSources", () => {
  it("maps agent CLI sessions and skips plain shells and unknown sessions", () => {
    const tabs: Record<string, Tab> = {
      s1: tab({ cliTool: "claude" }),
      s2: tab({ id: "tab-2", sessionId: "s2", cliTool: "none", title: "dev server" }),
      s3: tab({ id: "tab-3", sessionId: "s3", cliTool: "codex", title: "" }),
    };
    const statusMap = new Map([
      status("s1", { currentToolSummary: "编辑 approvals.rs" }),
      status("s2", { status: "active" }),
      status("s3", { status: "waitingInput" }),
      status("ghost"),
    ]);
    const sources = collectTerminalSources(statusMap, (id) => (tabs[id] ? location(tabs[id]) : null), new Map());
    expect(sources).toEqual([
      expect.objectContaining({ id: "s1", cli: "Claude", activity: "running", detail: "编辑 approvals.rs" }),
      expect.objectContaining({ id: "s3", cli: "Codex", activity: "needs", name: "bot-fix" }),
    ]);
  });

  it("treats idle / exited as idle and uses completion notifications as summary", () => {
    const sources = collectTerminalSources(
      new Map([status("s1", { status: "idle" })]),
      () => location(tab({ cliTool: "codex" })),
      new Map([["s1", "已开 PR #112"]]),
    );
    expect(sources[0]).toMatchObject({ activity: "idle", summary: "已开 PR #112" });
  });
});

describe("toIslandApproval", () => {
  it("passes the real ACP options through in order and counts the rest of the queue", () => {
    const approval = toIslandApproval([permission(), permission({ requestKey: "req-2" })]);
    expect(approval).toEqual({
      requestKey: "req-1",
      title: "想要运行一个命令",
      detail: "npm run tauri:dev",
      options: [
        { optionId: "once", name: "批准一次", kind: "allow_once" },
        { optionId: "always", name: "总是允许 npm run", kind: "allow_always" },
        { optionId: "no", name: "拒绝", kind: "reject_once" },
      ],
      responding: false,
      error: null,
      queued: 1,
    });
    expect(toIslandApproval([])).toBeNull();
  });
});

describe("collectChatSources", () => {
  const chat = (patch: Partial<AgentChatSessionState>): AgentChatSessionState => ({
    snapshot: { chatId: "c1", engineId: "claude", phase: "ready" },
    items: [],
    pendingPermissions: [],
    pendingPrompt: null,
    ...patch,
  } as AgentChatSessionState);

  it("derives needs / running / idle from permissions and phase", () => {
    const sources = collectChatSources({
      a: chat({ pendingPermissions: [permission()] }),
      b: chat({
        snapshot: { chatId: "b", engineId: "codex-app-server", phase: "generating" },
        items: [{ type: "tool_call", id: "t", at: 0, call: { toolCallId: "t", title: "cargo test", status: "in_progress" } }],
      }),
      c: chat({ items: [{ type: "assistant", id: "x", at: 0, text: "已开 PR" }] }),
      d: chat({ snapshot: null }),
    }, (id) => (id === "a" ? "dock-chat-2" : null));
    expect(sources.map(({ id, activity, cli }) => ({ id, activity, cli }))).toEqual([
      { id: "a", activity: "needs", cli: "Claude" },
      { id: "b", activity: "running", cli: "Codex" },
      { id: "c", activity: "idle", cli: "Claude" },
    ]);
    expect(sources[0].name).toBe("dock-chat-2");
    expect(sources[1].detail).toBe("cargo test");
    expect(sources[2].summary).toBe("已开 PR");
  });

  it("labels unknown engines with their raw id", () => {
    expect(engineLabel("gemini-cli")).toBe("Gemini");
    expect(engineLabel("mystery")).toBe("mystery");
  });
});

describe("pickQuota", () => {
  const entry = (observedAt: number, usedPercent: number, resetsAt: number | null): SessionCostEntry => ({
    loading: false,
    requestId: 1,
    snapshot: {
      rateLimits: {
        source: "codex-session-log",
        planType: null,
        limitReachedType: null,
        observedAt,
        windows: [{ slot: "primary", usedPercent, windowMinutes: 300, resetsAt }],
      },
    } as never,
  });

  it("takes the freshest account-wide snapshot and drops expired windows", () => {
    const quota = pickQuota(new Map([["a", entry(10, 80, 9_999)], ["b", entry(20, 12, 9_999)]]), 1_000);
    expect(quota).toEqual({ provider: "Codex", windows: [expect.objectContaining({ usedPercent: 12 })] });
    expect(pickQuota(new Map([["a", entry(10, 80, 500)]]), 1_000)).toBeNull();
    expect(pickQuota(new Map(), 0)).toBeNull();
  });
});

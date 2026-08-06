import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectTabsByContentType } from "@/lib/paneSessions";
import type { TabContentType } from "@/lib/tabContentType";
import { browserService } from "@/services/browserService";
import { terminalService } from "@/services/terminalService";
import { createPanel } from "@/lib/paneTree";
import { useContextUsageStore } from "@/stores/useContextUsageStore";
import { useTerminalInputActivityStore } from "@/stores/useTerminalInputActivityStore";
import { useTerminalStatusStore } from "@/stores/useTerminalStatusStore";
import type { Tab, TerminalStatusInfo } from "@/types";
import { TAB_LIFECYCLE } from "./registry";
import type { GuardContext } from "./registry";

vi.mock("@/services/terminalService", () => ({
  killedSessions: new Set<string>(),
  terminalService: {
    detachOutput: vi.fn(),
    detachExit: vi.fn(),
    killSession: vi.fn(async () => {}),
    getAllStatus: vi.fn(async () => []),
  },
}));

vi.mock("@/services/browserService", () => ({
  browserService: {
    close: vi.fn(async () => {}),
  },
}));

const detachOutput = vi.mocked(terminalService.detachOutput);
const detachExit = vi.mocked(terminalService.detachExit);
const browserClose = vi.mocked(browserService.close);

// contentType 的**全集**。新增一种就要在这里加一条，下面的穷举断言会逼着你同步
// TAB_LIFECYCLE（否则新类型的关闭路径静默无回收——正是 docs/78 §0.2 的泄漏形态）
// 以及 paneSessions.collectTabsByContentType 的分桶表。
const ALL_CONTENT_TYPES: TabContentType[] = [
  "terminal",
  "browser",
  "editor",
  "file-explorer",
  "mcp-config",
  "skill-manager",
  "memory-manager",
];

const inertCtx: GuardContext = {
  statusOf: () => null,
  isPoppedOut: () => false,
};

function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: "tab-1",
    title: "Tab 1",
    contentType: "terminal",
    projectId: "proj-1",
    projectPath: "C:/repo",
    sessionId: null,
    ...overrides,
  };
}

/** 分屏终端 tab：两个 leaf（s1 / s2），s2 还带 restoring 中的 savedSessionId。 */
function makeSplitTerminalTab(overrides: Partial<Tab> = {}): Tab {
  return makeTab({
    terminalRootPane: {
      type: "split",
      id: "split-1",
      direction: "horizontal",
      children: [
        { type: "leaf", id: "leaf-1", sessionId: "s1" },
        { type: "leaf", id: "leaf-2", sessionId: "s2", savedSessionId: "saved-1" },
      ],
      sizes: [50, 50],
    },
    activeTerminalPaneId: "leaf-1",
    ...overrides,
  });
}

function statusInfo(sessionId: string): TerminalStatusInfo {
  return { sessionId, status: "idle", lastOutputAt: 0, updatedAt: 0 };
}

beforeEach(() => {
  vi.clearAllMocks();
  useTerminalStatusStore.setState({ statusMap: new Map() });
  useContextUsageStore.setState({
    sessionId: null,
    snapshot: null,
    lastReady: null,
    loading: false,
    sessions: new Map(),
  });
});

describe("TAB_LIFECYCLE 穷举登记", () => {
  it("每种 contentType 都已登记，且三方法皆为函数", () => {
    for (const type of ALL_CONTENT_TYPES) {
      const entry = TAB_LIFECYCLE[type];
      expect(entry, `${type} 未登记`).toBeDefined();
      expect(entry.collectResources, `${type}.collectResources`).toBeTypeOf("function");
      expect(entry.closeGuards, `${type}.closeGuards`).toBeTypeOf("function");
      expect(entry.onClosed, `${type}.onClosed`).toBeTypeOf("function");
    }
  });

  it("登记表没有多余键（表与全集双向相等）", () => {
    expect(Object.keys(TAB_LIFECYCLE).sort()).toEqual([...ALL_CONTENT_TYPES].sort());
  });

  it("paneSessions.collectTabsByContentType 的桶键集与全集双向相等", () => {
    // 第二处 contentType 穷举点：分桶表是字面量对象，新增类型漏改会让新 tab
    // 静默掉出所有按类型的统计。纳入同一条穷举纪律。
    const buckets = collectTabsByContentType(createPanel());
    expect(Object.keys(buckets).sort()).toEqual([...ALL_CONTENT_TYPES].sort());
  });
});

describe("terminal", () => {
  const entry = TAB_LIFECYCLE.terminal;

  it("collectResources 收集分屏全量会话并并入 savedSessionId", () => {
    const { sessionIds } = entry.collectResources(makeSplitTerminalTab(), inertCtx);
    expect([...sessionIds].sort()).toEqual(["s1", "s2", "saved-1"].sort());
  });

  it("collectResources 对 sessionId 与 savedSessionId 相同的 leaf 去重", () => {
    const tab = makeTab({
      terminalRootPane: { type: "leaf", id: "leaf-1", sessionId: "s1", savedSessionId: "s1" },
      activeTerminalPaneId: "leaf-1",
    });
    expect(entry.collectResources(tab, inertCtx).sessionIds).toEqual(["s1"]);
  });

  it("collectResources 无 terminalRootPane 时兜底并入 tab 级 sessionId + savedSessionId", () => {
    const tab = makeTab({ sessionId: "s3", savedSessionId: "saved-3" });
    const { sessionIds } = entry.collectResources(tab, inertCtx);
    expect([...sessionIds].sort()).toEqual(["s3", "saved-3"].sort());
  });

  it("collectResources 经 ctx 收集已弹出窗口", () => {
    const ctx: GuardContext = { statusOf: () => null, isPoppedOut: (tabId) => tabId === "tab-1" };
    expect(entry.collectResources(makeSplitTerminalTab(), ctx).poppedOutTabIds).toEqual(["tab-1"]);
    expect(entry.collectResources(makeSplitTerminalTab(), inertCtx).poppedOutTabIds).toEqual([]);
  });

  // ===== B1-06：agent-busy 守卫已启用。以下四条锁死「何时弹、何时不弹」 =====

  it("agent 会话忙碌时逐 leaf 产出确认项", () => {
    const busyCtx: GuardContext = { statusOf: () => "thinking", isPoppedOut: () => false };
    const guards = entry.closeGuards(makeSplitTerminalTab({ cliTool: "claude" }), busyCtx);
    expect(guards.map((g) => g.kind)).toEqual(["agent-busy", "agent-busy", "agent-busy"]);
    expect(guards.every((g) => g.kind === "agent-busy" && g.status === "thinking")).toBe(true);
  });

  it("waitingInput 同样拦——它不在 BUSY_STATUSES 里，但静默关掉损失一样大", () => {
    const ctx: GuardContext = { statusOf: () => "waitingInput", isPoppedOut: () => false };
    const guards = entry.closeGuards(makeTab({ cliTool: "codex", sessionId: "s1" }), ctx);
    expect(guards).toHaveLength(1);
    expect(guards[0]).toMatchObject({ kind: "agent-busy", status: "waitingInput" });
  });

  it("纯 shell 不拦——即使状态看起来在忙（三轴模型：shell 无「内容忙碌」轴）", () => {
    const busyCtx: GuardContext = { statusOf: () => "thinking", isPoppedOut: () => false };
    expect(entry.closeGuards(makeSplitTerminalTab(), busyCtx)).toEqual([]);
    expect(entry.closeGuards(makeSplitTerminalTab({ cliTool: "none" }), busyCtx)).toEqual([]);
  });

  it("agent 空闲不拦（idle / 无状态记录）", () => {
    const idleCtx: GuardContext = { statusOf: () => "idle", isPoppedOut: () => false };
    const noneCtx: GuardContext = { statusOf: () => null, isPoppedOut: () => false };
    expect(entry.closeGuards(makeSplitTerminalTab({ cliTool: "claude" }), idleCtx)).toEqual([]);
    expect(entry.closeGuards(makeSplitTerminalTab({ cliTool: "claude" }), noneCtx)).toEqual([]);
  });

  it("legacy launchClaude 快照也认作 agent", () => {
    const busyCtx: GuardContext = { statusOf: () => "toolRunning", isPoppedOut: () => false };
    const guards = entry.closeGuards(makeTab({ launchClaude: true, sessionId: "s1" }), busyCtx);
    expect(guards).toHaveLength(1);
  });

  it("onClosed detach:true 时对每个会话 detachOutput + detachExit", () => {
    entry.onClosed(makeSplitTerminalTab(), { detach: true, reason: "user-close" });
    for (const sessionId of ["s1", "s2", "saved-1"]) {
      expect(detachOutput).toHaveBeenCalledWith(sessionId);
      expect(detachExit).toHaveBeenCalledWith(sessionId);
    }
  });

  it("onClosed detach:false 时不 detach（管线阶段 1 已做，重复 detach 会误伤重挂视图）", () => {
    entry.onClosed(makeSplitTerminalTab(), { detach: false, reason: "user-close" });
    expect(detachOutput).not.toHaveBeenCalled();
    expect(detachExit).not.toHaveBeenCalled();
  });

  it("onClosed 清理 useTerminalStatusStore 条目，且不动无关会话", () => {
    useTerminalStatusStore.setState({
      statusMap: new Map([
        ["s1", statusInfo("s1")],
        ["s2", statusInfo("s2")],
        ["other", statusInfo("other")],
      ]),
    });
    entry.onClosed(makeSplitTerminalTab(), { detach: false, reason: "user-close" });
    const map = useTerminalStatusStore.getState().statusMap;
    expect(map.has("s1")).toBe(false);
    expect(map.has("s2")).toBe(false);
    expect(map.has("other")).toBe(true);
  });

  it("onClosed 回收 per-session 上下文用量缓存条目（exit 驱动的 dropSession 对管线销毁不可达）", () => {
    const cacheEntry = { snapshot: null, lastReady: null, loading: false, requestId: 0 };
    useContextUsageStore.setState({
      sessions: new Map([
        ["s1", cacheEntry],
        ["unrelated", cacheEntry],
      ]),
    });
    entry.onClosed(makeSplitTerminalTab(), { detach: false, reason: "user-close" });
    const sessions = useContextUsageStore.getState().sessions;
    expect(sessions.has("s1")).toBe(false);
    expect(sessions.has("unrelated")).toBe(true);
  });

  it("onClosed 清理输入活跃条目，且不动无关会话（会话键卫星态与 status 同点清）", () => {
    useTerminalInputActivityStore.getState().recordInput("s1", "working");
    useTerminalInputActivityStore.getState().recordInput("unrelated", "working");
    entry.onClosed(makeSplitTerminalTab(), { detach: false, reason: "user-close" });
    expect(useTerminalInputActivityStore.getState().getEntry("s1")).toBeUndefined();
    expect(useTerminalInputActivityStore.getState().getEntry("s2")).toBeUndefined();
    expect(useTerminalInputActivityStore.getState().getEntry("unrelated")).toBeDefined();
    useTerminalInputActivityStore.getState().clearSession("unrelated");
  });

  it("onClosed 仅当被关会话是 contextUsage 当前会话时才清（单例 store）", () => {
    useContextUsageStore.setState({ sessionId: "s2" });
    entry.onClosed(makeSplitTerminalTab(), { detach: false, reason: "user-close" });
    expect(useContextUsageStore.getState().sessionId).toBeNull();

    useContextUsageStore.setState({ sessionId: "unrelated" });
    entry.onClosed(makeSplitTerminalTab(), { detach: false, reason: "user-close" });
    expect(useContextUsageStore.getState().sessionId).toBe("unrelated");
  });

  it("onClosed 不直接 kill——kill 属管线阶段 2，不属附属清理", () => {
    entry.onClosed(makeSplitTerminalTab(), { detach: true, reason: "user-close" });
    expect(terminalService.killSession).not.toHaveBeenCalled();
  });
});

describe("browser", () => {
  const entry = TAB_LIFECYCLE.browser;
  const browserTab = makeTab({ contentType: "browser", browserUrl: "https://example.com" });

  it("collectResources 无会话", () => {
    expect(entry.collectResources(browserTab, inertCtx).sessionIds).toEqual([]);
  });

  it("closeGuards v1 不拦", () => {
    expect(entry.closeGuards(browserTab, inertCtx)).toEqual([]);
  });

  it("onClosed 收编 webview 关闭（不再只靠 React unmount 兜底）", () => {
    entry.onClosed(browserTab, { detach: false, reason: "snapshot-apply" });
    expect(browserClose).toHaveBeenCalledWith("tab-1");
  });

  it("onClosed 对 webview 关闭失败静默容错", async () => {
    browserClose.mockRejectedValueOnce(new Error("webview gone"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    entry.onClosed(browserTab, { detach: false, reason: "user-close" });
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());
    errorSpy.mockRestore();
  });
});

describe("editor", () => {
  const entry = TAB_LIFECYCLE.editor;

  it("closeGuards 承接现状：dirty → editor-dirty 确认项", () => {
    const tab = makeTab({ contentType: "editor", title: "a.ts", dirty: true });
    expect(entry.closeGuards(tab, inertCtx)).toEqual([
      { kind: "editor-dirty", tabId: "tab-1", tabTitle: "a.ts" },
    ]);
  });

  it("closeGuards 非 dirty 放行", () => {
    const tab = makeTab({ contentType: "editor", dirty: false });
    expect(entry.closeGuards(tab, inertCtx)).toEqual([]);
  });

  it("collectResources 无会话，onClosed 为 no-op", () => {
    const tab = makeTab({ contentType: "editor" });
    expect(entry.collectResources(tab, inertCtx).sessionIds).toEqual([]);
    expect(() => entry.onClosed(tab, { detach: false, reason: "user-close" })).not.toThrow();
  });
});

describe("无资源类型（file-explorer / mcp-config / skill-manager / memory-manager）", () => {
  const inertTypes: TabContentType[] = [
    "file-explorer",
    "mcp-config",
    "skill-manager",
    "memory-manager",
  ];

  it.each(inertTypes)("%s：无会话、无守卫、onClosed no-op，但弹出窗口仍被收集", (type) => {
    const entry = TAB_LIFECYCLE[type];
    const tab = makeTab({ contentType: type });
    const poppedCtx: GuardContext = { statusOf: () => null, isPoppedOut: () => true };

    expect(entry.collectResources(tab, inertCtx).sessionIds).toEqual([]);
    expect(entry.collectResources(tab, poppedCtx).poppedOutTabIds).toEqual(["tab-1"]);
    expect(entry.closeGuards(tab, inertCtx)).toEqual([]);
    expect(() => entry.onClosed(tab, { detach: false, reason: "snapshot-apply" })).not.toThrow();
  });
});

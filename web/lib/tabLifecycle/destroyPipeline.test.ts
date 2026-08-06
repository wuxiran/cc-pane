import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPoppedTabs,
  isTabPoppedOut,
  markTabReclaimed,
} from "@/services/popupWindowService";
import { terminalService } from "@/services/terminalService";
import { isTerminalReclaimKillReason } from "@/services/terminalLaunchDeadline";
import { useContextUsageStore } from "@/stores/useContextUsageStore";
import { useTerminalStatusStore } from "@/stores/useTerminalStatusStore";
import type { KillReason, Tab } from "@/types";
import { useTabAttentionStore } from "@/stores/useTabAttentionStore";
import { useTabViewStateStore } from "@/stores/useTabViewStateStore";
import {
  ALL_DESTROY_REASONS,
  DESTROY_KILL_REASON,
  DESTROY_POLICY,
  commitResourceDestroy,
  planTabDestroy,
  sweepOwnerState,
} from "./destroyPipeline";
import type { DestroyReason } from "./destroyPipeline";
import type { GuardContext } from "./registry";

const callOrder: string[] = [];

vi.mock("@/services/terminalService", () => ({
  killedSessions: new Set<string>(),
  terminalService: {
    detachOutput: vi.fn((id: string) => callOrder.push(`detachOutput:${id}`)),
    detachExit: vi.fn((id: string) => callOrder.push(`detachExit:${id}`)),
    killSession: vi.fn(async (id: string) => {
      callOrder.push(`kill:${id}`);
    }),
    getAllStatus: vi.fn(async () => []),
  },
}));

vi.mock("@/services/popupWindowService", () => ({
  getPoppedTabs: vi.fn(() => new Map<string, string>()),
  isTabPoppedOut: vi.fn(() => false),
  markTabReclaimed: vi.fn((id: string) => callOrder.push(`markReclaimed:${id}`)),
}));

const closePopup = vi.fn(async () => {
  callOrder.push("closePopup");
});
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: {
    getByLabel: vi.fn(async () => ({ close: closePopup })),
  },
}));

const detachOutput = vi.mocked(terminalService.detachOutput);
const killSession = vi.mocked(terminalService.killSession);
const mockGetPoppedTabs = vi.mocked(getPoppedTabs);
const mockIsTabPoppedOut = vi.mocked(isTabPoppedOut);
const mockMarkTabReclaimed = vi.mocked(markTabReclaimed);

// DestroyReason 的**全集**手写副本。新增来源要同步这里 + 矩阵两张表，
// 下面的双向穷举断言会逼着三处一起改（仿 tabContentType.test.ts 范式）。
const HANDWRITTEN_REASONS: DestroyReason[] = [
  "user-close",
  "batch-close",
  "close-pane",
  "delete-layout",
  "snapshot-apply",
  "backend-close",
  "editor-path-close",
];

/** KillReason 全集（types/terminal.ts 的联合）。回收类三值锁在下面的双向断言里。 */
const ALL_KILL_REASONS: KillReason[] = [
  "user-close",
  "mcp",
  "orphan-reclaim",
  "daemon-reaper",
  "launch-timeout",
  "unknown",
];

const RECLAIM_KILL_REASONS: ReadonlySet<KillReason> = new Set([
  "orphan-reclaim",
  "daemon-reaper",
  "launch-timeout",
]);

const inertCtx: GuardContext = {
  statusOf: () => null,
  isPoppedOut: () => false,
};

let tabSeq = 0;
function makeTab(overrides: Partial<Tab> = {}): Tab {
  tabSeq += 1;
  return {
    id: `tab-${tabSeq}`,
    title: `Tab ${tabSeq}`,
    contentType: "terminal",
    projectId: "proj-1",
    projectPath: "C:/repo",
    sessionId: null,
    ...overrides,
  };
}

function makeTerminalTab(sessionId: string, overrides: Partial<Tab> = {}): Tab {
  return makeTab({ sessionId, ...overrides });
}

beforeEach(() => {
  vi.clearAllMocks();
  callOrder.length = 0;
  tabSeq = 0;
  // killSession 的实现会被个别测试替换成抛错版，clearAllMocks 不还原实现，这里显式复位
  killSession.mockImplementation(async (id: string) => {
    callOrder.push(`kill:${id}`);
  });
  mockGetPoppedTabs.mockReturnValue(new Map());
  mockIsTabPoppedOut.mockReturnValue(false);
  useTerminalStatusStore.setState({ statusMap: new Map() });
  useContextUsageStore.setState({
    sessionId: null,
    snapshot: null,
    lastReady: null,
    loading: false,
  });
});

describe("DESTROY_POLICY 矩阵穷举", () => {
  it("矩阵键集与手写全集双向相等", () => {
    expect(Object.keys(DESTROY_POLICY).sort()).toEqual([...HANDWRITTEN_REASONS].sort());
    expect(Object.keys(DESTROY_KILL_REASON).sort()).toEqual([...HANDWRITTEN_REASONS].sort());
    expect([...ALL_DESTROY_REASONS].sort()).toEqual([...HANDWRITTEN_REASONS].sort());
  });

  it("逐格锁定矩阵取值（改动必须是有意的：先改这里再改表）", () => {
    expect(DESTROY_POLICY).toEqual({
      "user-close": { vetoable: true, recordsClosedTabs: true, respectsPinned: true, kills: true, closesPopups: true },
      "batch-close": { vetoable: true, recordsClosedTabs: true, respectsPinned: true, kills: true, closesPopups: true },
      "close-pane": { vetoable: true, recordsClosedTabs: true, respectsPinned: false, kills: true, closesPopups: true },
      "delete-layout": { vetoable: true, recordsClosedTabs: false, respectsPinned: false, kills: true, closesPopups: true },
      "snapshot-apply": { vetoable: false, recordsClosedTabs: false, respectsPinned: false, kills: true, closesPopups: true },
      "backend-close": { vetoable: false, recordsClosedTabs: false, respectsPinned: false, kills: false, closesPopups: true },
      "editor-path-close": { vetoable: false, recordsClosedTabs: false, respectsPinned: false, kills: false, closesPopups: false },
    });
  });
});

describe("KillReason 映射三条语义锁", () => {
  it("① kills=true → 映射非 null 且不落回收类（回收类会让 session-killed 保留标签，标签关不掉）", () => {
    for (const reason of ALL_DESTROY_REASONS) {
      if (!DESTROY_POLICY[reason].kills) continue;
      const mapped = DESTROY_KILL_REASON[reason];
      expect(mapped, `${reason} kills=true 但映射为 null`).not.toBeNull();
      expect(RECLAIM_KILL_REASONS.has(mapped as KillReason), `${reason} 映射进了回收类`).toBe(false);
      expect(isTerminalReclaimKillReason(mapped as KillReason), `${reason} 会被 session-killed 分流成保留标签`).toBe(false);
    }
  });

  it("② kills=false → 映射为 null", () => {
    for (const reason of ALL_DESTROY_REASONS) {
      if (DESTROY_POLICY[reason].kills) continue;
      expect(DESTROY_KILL_REASON[reason], `${reason} kills=false 但映射非 null`).toBeNull();
    }
  });

  it("③ isTerminalReclaimKillReason 的回收类集合与本表口径双向相等", () => {
    // 双向：本表认定的回收类每个都被判定函数认；判定函数认的每个都在本表集合里。
    // 任一侧加值不同步会让「前端主动关」与「保留标签」的分流悄悄错位。
    for (const reason of ALL_KILL_REASONS) {
      expect(
        isTerminalReclaimKillReason(reason),
        `isTerminalReclaimKillReason(${reason}) 与 RECLAIM_KILL_REASONS 口径不一致`,
      ).toBe(RECLAIM_KILL_REASONS.has(reason));
    }
  });
});

describe("planTabDestroy（纯函数）", () => {
  it("聚合去重会话与弹出窗口", () => {
    const shared = makeTerminalTab("s1");
    const other = makeTerminalTab("s2");
    mockIsTabPoppedOut.mockImplementation((tabId) => tabId === other.id);
    const ctx: GuardContext = { statusOf: () => null, isPoppedOut: (id) => id === other.id };

    const plan = planTabDestroy([shared, other, makeTerminalTab("s1")], "user-close", ctx);
    expect([...plan.sessionIds].sort()).toEqual(["s1", "s2"]);
    expect(plan.poppedOutTabIds).toEqual([other.id]);
  });

  it("respectsPinned=true 的 reason 豁免 pinned tab（连资源都不收集）", () => {
    const pinned = makeTerminalTab("s-pinned", { pinned: true });
    const normal = makeTerminalTab("s-normal");
    const plan = planTabDestroy([pinned, normal], "user-close", inertCtx);
    expect(plan.tabs.map((t) => t.id)).toEqual([normal.id]);
    expect(plan.skippedPinnedTabIds).toEqual([pinned.id]);
    expect(plan.sessionIds).toEqual(["s-normal"]);
  });

  it("respectsPinned=false 的 reason 连 pinned 一起销毁（如 delete-layout）", () => {
    const pinned = makeTerminalTab("s-pinned", { pinned: true });
    const plan = planTabDestroy([pinned], "delete-layout", inertCtx);
    expect(plan.tabs.map((t) => t.id)).toEqual([pinned.id]);
    expect(plan.skippedPinnedTabIds).toEqual([]);
    expect(plan.sessionIds).toEqual(["s-pinned"]);
  });

  it("vetoable=true 时聚合 closeGuards（editor dirty 承接现状）", () => {
    const dirtyEditor = makeTab({ contentType: "editor", dirty: true, title: "a.ts" });
    const plan = planTabDestroy([dirtyEditor], "user-close", inertCtx);
    expect(plan.guards).toEqual([
      { kind: "editor-dirty", tabId: dirtyEditor.id, tabTitle: "a.ts" },
    ]);
  });

  it("vetoable=false 的 reason 恒不产出 guards（自动化路径不许被确认卡死）", () => {
    const dirtyEditor = makeTab({ contentType: "editor", dirty: true });
    for (const reason of ALL_DESTROY_REASONS) {
      if (DESTROY_POLICY[reason].vetoable) continue;
      expect(planTabDestroy([dirtyEditor], reason, inertCtx).guards, reason).toEqual([]);
    }
  });

  it("terminal 本轮不产出 agent-busy guard（B1-06 才打开）", () => {
    const busyCtx: GuardContext = { statusOf: () => "toolRunning", isPoppedOut: () => false };
    const plan = planTabDestroy([makeTerminalTab("s-busy")], "user-close", busyCtx);
    expect(plan.guards).toEqual([]);
  });

  it("不产生副作用（零 service 调用）", () => {
    planTabDestroy([makeTerminalTab("s1")], "user-close", inertCtx);
    expect(detachOutput).not.toHaveBeenCalled();
    expect(killSession).not.toHaveBeenCalled();
  });
});

describe("commitResourceDestroy 阶段顺序", () => {
  it("先全部 detach 再 kill（防杀 A 时 B 的 exit 回流），kill 带映射 reason", async () => {
    await commitResourceDestroy([makeTerminalTab("s1"), makeTerminalTab("s2")], "user-close");

    // 全部 detach 完成后才开始 kill
    const firstKill = callOrder.findIndex((c) => c.startsWith("kill:"));
    const lastDetach = callOrder.reduce(
      (max, c, i) => (c.startsWith("detach") ? i : max),
      -1,
    );
    expect(firstKill).toBeGreaterThan(lastDetach);
    expect(killSession).toHaveBeenCalledWith("s1", "user-close");
    expect(killSession).toHaveBeenCalledWith("s2", "user-close");
  });

  it("kill 之后才关弹出窗口，弹窗回收两份真相都做（close + markTabReclaimed）", async () => {
    const tab = makeTerminalTab("s1");
    mockIsTabPoppedOut.mockImplementation((id) => id === tab.id);
    mockGetPoppedTabs.mockReturnValue(new Map([[tab.id, `popup-${tab.id}`]]));

    await commitResourceDestroy([tab], "user-close");

    expect(callOrder.indexOf("kill:s1")).toBeLessThan(callOrder.indexOf("closePopup"));
    expect(closePopup).toHaveBeenCalled();
    expect(mockMarkTabReclaimed).toHaveBeenCalledWith(tab.id);
  });

  it("kills=false 的 reason 断言零 killSession 调用，但 detach 与 onClosed 照常", async () => {
    for (const reason of ALL_DESTROY_REASONS) {
      if (DESTROY_POLICY[reason].kills) continue;
      vi.clearAllMocks();
      mockGetPoppedTabs.mockReturnValue(new Map());
      await commitResourceDestroy([makeTerminalTab(`s-${reason}`)], reason);
      expect(killSession, `${reason} 不该 kill`).not.toHaveBeenCalled();
      expect(detachOutput, `${reason} 仍需 detach`).toHaveBeenCalledWith(`s-${reason}`);
    }
  });

  it("protectSessionIds 名单内的会话不 kill 但仍 detach", async () => {
    await commitResourceDestroy(
      [makeTerminalTab("s-keep"), makeTerminalTab("s-kill")],
      "snapshot-apply",
      { protectSessionIds: new Set(["s-keep"]) },
    );
    expect(killSession).toHaveBeenCalledTimes(1);
    expect(killSession).toHaveBeenCalledWith("s-kill", "user-close");
    expect(detachOutput).toHaveBeenCalledWith("s-keep");
  });

  it("closesPopups=false 的 reason（editor-path-close）不触碰弹出窗口", async () => {
    const tab = makeTab({ contentType: "editor" });
    mockIsTabPoppedOut.mockReturnValue(true);
    mockGetPoppedTabs.mockReturnValue(new Map([[tab.id, `popup-${tab.id}`]]));

    await commitResourceDestroy([tab], "editor-path-close");

    expect(closePopup).not.toHaveBeenCalled();
    expect(mockMarkTabReclaimed).not.toHaveBeenCalled();
  });

  it("阶段 4 执行 per-tab onClosed 附属清理（status/contextUsage 条目）", async () => {
    useTerminalStatusStore.setState({
      statusMap: new Map([
        ["s1", { sessionId: "s1", status: "idle", lastOutputAt: 0, updatedAt: 0 }],
      ]),
    });
    useContextUsageStore.setState({ sessionId: "s1" });

    await commitResourceDestroy([makeTerminalTab("s1")], "user-close");

    expect(useTerminalStatusStore.getState().statusMap.has("s1")).toBe(false);
    expect(useContextUsageStore.getState().sessionId).toBeNull();
  });

  it("onClosed 收到 detach:false（阶段 1 已全量 detach，不得重复）", async () => {
    await commitResourceDestroy([makeTerminalTab("s1")], "user-close");
    // 若 onClosed 又 detach 一次，s1 会出现两组 detach 调用
    expect(detachOutput).toHaveBeenCalledTimes(1);
  });

  it("单个 killSession 失败不中断管线（其余 kill 与后续阶段照常）", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    killSession.mockImplementation(async (id: string) => {
      callOrder.push(`kill:${id}`);
      if (id === "s1") throw new Error("kill failed");
    });
    const tab2 = makeTerminalTab("s2");
    useTerminalStatusStore.setState({
      statusMap: new Map([
        ["s2", { sessionId: "s2", status: "idle", lastOutputAt: 0, updatedAt: 0 }],
      ]),
    });

    await commitResourceDestroy([makeTerminalTab("s1"), tab2], "user-close");

    expect(callOrder).toContain("kill:s2");
    expect(useTerminalStatusStore.getState().statusMap.has("s2")).toBe(false);
    errorSpy.mockRestore();
  });

  it("respectsPinned 贯穿 commit：user-close 不杀 pinned tab 的会话", async () => {
    await commitResourceDestroy(
      [makeTerminalTab("s-pinned", { pinned: true }), makeTerminalTab("s-normal")],
      "user-close",
    );
    expect(killSession).toHaveBeenCalledTimes(1);
    expect(killSession).toHaveBeenCalledWith("s-normal", "user-close");
    expect(detachOutput).not.toHaveBeenCalledWith("s-pinned");
  });
});

describe("sweepOwnerState（owner 键卫星态清扫）", () => {
  it("清掉视图聚合与注意标记，且不动其他 owner", () => {
    useTabViewStateStore.getState().reportView("tab-swept", "primary", "active");
    useTabViewStateStore.getState().reportView("tab-kept", "primary", "active");
    useTabAttentionStore.getState().markAttention("tab-swept", "error");
    useTabAttentionStore.getState().markAttention("tab-kept", "waiting-input");

    sweepOwnerState(["tab-swept"]);

    expect(useTabViewStateStore.getState().aggregate["tab-swept"]).toBeUndefined();
    expect(useTabViewStateStore.getState().getViewVisibility("tab-swept", "primary")).toBeUndefined();
    expect(useTabViewStateStore.getState().aggregate["tab-kept"]).toBeDefined();
    expect(useTabAttentionStore.getState().entries["tab-swept"]).toBeUndefined();
    expect(useTabAttentionStore.getState().entries["tab-kept"]).toBeDefined();

    sweepOwnerState(["tab-kept"]);
  });
});

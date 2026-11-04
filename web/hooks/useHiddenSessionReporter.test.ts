// hidden 上报派生逻辑测试（批3 闸门接线）。
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { deriveHiddenSessions, useHiddenSessionReporter } from "./useHiddenSessionReporter";
import { usePanesStore } from "@/stores";
import { useTabViewStateStore } from "@/stores/useTabViewStateStore";
import { setHiddenTerminalOutputSessions } from "@/services/terminalService";
import type { ViewAggregate } from "@/stores/useTabViewStateStore";
import type { Panel, Tab, TerminalPaneLeaf } from "@/types";

const { invokeIfTauriMock } = vi.hoisted(() => ({ invokeIfTauriMock: vi.fn() }));

vi.mock("@/services/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/runtime")>()),
  isTauriRuntime: () => true,
  invokeIfTauri: invokeIfTauriMock,
}));

function agg(anyVisible: boolean): ViewAggregate {
  return { anyVisible, anyActive: false, foregroundLastSeenAt: null, lastReportedVisible: anyVisible };
}

function tab(id: string, sessionId: string, saved?: string): Tab {
  const leaf: TerminalPaneLeaf = {
    type: "leaf", id: `${id}-leaf`, sessionId,
    ...(saved ? { savedSessionId: saved } : {}),
  };
  return {
    id, title: id, contentType: "terminal", projectId: "p", projectPath: "/tmp/p",
    sessionId, terminalRootPane: leaf, activeTerminalPaneId: leaf.id,
  } as Tab;
}

function panel(id: string, tabs: Tab[]): Panel {
  return { type: "panel", id, tabs, activeTabId: tabs[0]?.id ?? "" };
}

describe("deriveHiddenSessions", () => {
  it("anyVisible=false 的 owner 的会话进隐藏集（含 savedSessionId，与销毁口径一致）", () => {
    const p1 = panel("p1", [tab("t1", "s1", "s1-saved"), tab("t2", "s2")]);
    const hidden = deriveHiddenSessions(
      { t1: agg(false), t2: agg(true) },
      [{ id: "l1", rootPane: p1 }],
      "l1", p1, () => false,
    );
    expect(hidden).toEqual(["s1", "s1-saved"]);
  });

  it("**无聚合记录的 owner 不进隐藏集**——安全默认，宁可多推流也不错杀", () => {
    const p1 = panel("p1", [tab("t-unknown", "s-x")]);
    expect(deriveHiddenSessions({}, [{ id: "l1", rootPane: p1 }], "l1", p1, () => false)).toEqual([]);
  });

  it("selfchat 命名空间不参与（它没有 daemon 镜像诉求）", () => {
    const p1 = panel("p1", []);
    expect(deriveHiddenSessions(
      { "selfchat:abc": agg(false) },
      [{ id: "l1", rootPane: p1 }], "l1", p1, () => false,
    )).toEqual([]);
  });

  it("跨布局收集：非当前布局的隐藏标签也计入", () => {
    const p1 = panel("p1", [tab("t1", "s1")]);
    const p2 = panel("p2", [tab("t2", "s2")]);
    const hidden = deriveHiddenSessions(
      { t1: agg(false), t2: agg(false) },
      [{ id: "l1", rootPane: p1 }, { id: "l2", rootPane: p2 }],
      "l1", p1, () => false,
    );
    expect(hidden).toEqual(["s1", "s2"]);
  });

  it("输出排序稳定（同值去抖比较依赖它）", () => {
    const p1 = panel("p1", [tab("tb", "s-b"), tab("ta", "s-a")]);
    const hidden = deriveHiddenSessions(
      { ta: agg(false), tb: agg(false) },
      [{ id: "l1", rootPane: p1 }], "l1", p1, () => false,
    );
    expect(hidden).toEqual(["s-a", "s-b"]);
  });

  it("**弹出标签排除**：主窗口切走也不报隐藏（弹窗在另一上下文，掐了它会冻结）", () => {
    const p1 = panel("p1", [tab("t-popped", "s-popped"), tab("t-normal", "s-normal")]);
    const hidden = deriveHiddenSessions(
      { "t-popped": agg(false), "t-normal": agg(false) },
      [{ id: "l1", rootPane: p1 }],
      "l1", p1,
      (tabId) => tabId === "t-popped",
    );
    expect(hidden).toEqual(["s-normal"]);
  });
});

describe("useHiddenSessionReporter", () => {
  const LEFT = "tab-left";
  const RIGHT = "tab-right";

  function reports(): string[][] {
    return invokeIfTauriMock.mock.calls
      .filter(([command]) => command === "set_hidden_terminal_sessions")
      .map(([, args]) => (args as { sessions: string[] }).sessions);
  }

  function lastReport(): string[] | undefined {
    const all = reports();
    return all[all.length - 1];
  }

  function setVisible(left: boolean, right: boolean) {
    useTabViewStateStore.setState({
      aggregate: { [LEFT]: agg(left), [RIGHT]: agg(right) },
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    invokeIfTauriMock.mockReset().mockResolvedValue(undefined);
    const rootPane = panel("panel-1", [tab(LEFT, "s-left"), tab(RIGHT, "s-right")]);
    usePanesStore.setState({
      rootPane,
      currentLayoutId: "layout-1",
      layouts: [{ id: "layout-1", rootPane }],
      poppedOutTabs: new Set<string>(),
    } as never);
    setVisible(true, false);
  });

  afterEach(() => {
    vi.useRealTimers();
    setHiddenTerminalOutputSessions([]);
  });

  it("解除隐藏立即上报：快照请求必须排在 daemon 恢复投递之后", async () => {
    renderHook(() => useHiddenSessionReporter());
    await vi.advanceTimersByTimeAsync(150);
    expect(lastReport()).toEqual(["s-right"]);

    setVisible(true, true);

    expect(lastReport()).toEqual([]);
  });

  it("新增隐藏仍走去抖：高频切换不必每次打到 daemon", async () => {
    renderHook(() => useHiddenSessionReporter());
    await vi.advanceTimersByTimeAsync(150);
    const before = reports().length;

    setVisible(false, false);
    expect(reports().length).toBe(before);

    await vi.advanceTimersByTimeAsync(150);
    expect(lastReport()).toEqual(["s-left", "s-right"]);
  });
});

// hidden 上报派生逻辑测试（批3 闸门接线）。
import { describe, it, expect } from "vitest";
import { deriveHiddenSessions } from "./useHiddenSessionReporter";
import type { ViewAggregate } from "@/stores/useTabViewStateStore";
import type { Panel, Tab, TerminalPaneLeaf } from "@/types";

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
      "l1", p1,
    );
    expect(hidden).toEqual(["s1", "s1-saved"]);
  });

  it("**无聚合记录的 owner 不进隐藏集**——安全默认，宁可多推流也不错杀", () => {
    const p1 = panel("p1", [tab("t-unknown", "s-x")]);
    expect(deriveHiddenSessions({}, [{ id: "l1", rootPane: p1 }], "l1", p1)).toEqual([]);
  });

  it("selfchat 命名空间不参与（它没有 daemon 镜像诉求）", () => {
    const p1 = panel("p1", []);
    expect(deriveHiddenSessions(
      { "selfchat:abc": agg(false) },
      [{ id: "l1", rootPane: p1 }], "l1", p1,
    )).toEqual([]);
  });

  it("跨布局收集：非当前布局的隐藏标签也计入", () => {
    const p1 = panel("p1", [tab("t1", "s1")]);
    const p2 = panel("p2", [tab("t2", "s2")]);
    const hidden = deriveHiddenSessions(
      { t1: agg(false), t2: agg(false) },
      [{ id: "l1", rootPane: p1 }, { id: "l2", rootPane: p2 }],
      "l1", p1,
    );
    expect(hidden).toEqual(["s1", "s2"]);
  });

  it("输出排序稳定（同值去抖比较依赖它）", () => {
    const p1 = panel("p1", [tab("tb", "s-b"), tab("ta", "s-a")]);
    const hidden = deriveHiddenSessions(
      { ta: agg(false), tb: agg(false) },
      [{ id: "l1", rootPane: p1 }], "l1", p1,
    );
    expect(hidden).toEqual(["s-a", "s-b"]);
  });
});

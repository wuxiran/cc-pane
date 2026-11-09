import { describe, expect, it } from "vitest";
import type { LayoutEntry, Tab } from "@/types";
import {
  layoutsHaveAgentChat,
  layoutUnmountBlocker,
  planLayoutEviction,
} from "./layoutMountPolicy";

function tab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: overrides.id ?? "t",
    title: "t",
    contentType: "terminal",
    projectId: "p",
    projectPath: "/p",
    sessionId: "s",
    ...overrides,
  } as Tab;
}

function layout(id: string, tabs: Tab[] = [tab()]): LayoutEntry {
  return {
    id,
    name: id,
    kind: "normal",
    activePaneId: `${id}-pane`,
    rootPane: { type: "panel", id: `${id}-pane`, tabs, activeTabId: tabs[0]?.id ?? "" },
  } as LayoutEntry;
}

describe("layoutUnmountBlocker", () => {
  it("纯终端布局可卸载", () => {
    expect(layoutUnmountBlocker(layout("a"))).toBeNull();
  });

  it.each(["browser", "dsh", "editor", "agent-chat"] as const)("%s 标签阻止卸载", (contentType) => {
    expect(layoutUnmountBlocker(layout("a", [tab(), tab({ id: "x", contentType })]))).toBe("unsafe-content");
  });

  it("dirty 标签与 SSH 终端阻止卸载", () => {
    expect(layoutUnmountBlocker(layout("a", [tab({ dirty: true })]))).toBe("dirty-tab");
    expect(layoutUnmountBlocker(layout("a", [tab({ ssh: { host: "h" } as Tab["ssh"] })]))).toBe("ssh-terminal");
    const leafSsh = tab({
      terminalRootPane: { type: "leaf", id: "leaf", sessionId: "s", ssh: { host: "h" } as Tab["ssh"] },
    });
    expect(layoutUnmountBlocker(layout("a", [leafSsh]))).toBe("ssh-terminal");
  });

  it("layoutsHaveAgentChat 识别任意布局里的 agent-chat", () => {
    expect(layoutsHaveAgentChat([layout("a")])).toBe(false);
    expect(layoutsHaveAgentChat([layout("a"), layout("b", [tab({ contentType: "agent-chat" })])])).toBe(true);
  });
});

describe("planLayoutEviction", () => {
  const base = {
    layouts: [layout("cur"), layout("old"), layout("fresh"), layout("web", [tab({ contentType: "browser" })])],
    mounted: new Set(["cur", "old", "fresh", "web"]),
    currentLayoutId: "cur",
    delayMs: 1000,
  };

  it("只卸载已到期、可卸载、非当前的布局，并给出下一到期时刻", () => {
    const plan = planLayoutEviction({
      ...base,
      hiddenSince: new Map([["cur", 0], ["old", 0], ["fresh", 800], ["web", 0]]),
      now: 1200,
    });
    expect(plan.expired).toEqual(["old"]);
    expect(plan.nextDeadline).toBe(1800);
  });

  it("未计时 / 未挂载的布局不参与", () => {
    const plan = planLayoutEviction({
      ...base,
      mounted: new Set(["cur", "fresh"]),
      hiddenSince: new Map([["old", 0]]),
      now: 5000,
    });
    expect(plan).toEqual({ expired: [], nextDeadline: null });
  });
});

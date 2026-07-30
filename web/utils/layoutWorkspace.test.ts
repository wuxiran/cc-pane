import { describe, expect, it } from "vitest";
import {
  findLayoutForWorkspace,
  getLayoutWorkspaceBinding,
  resolveWorkspaceLaunchLayout,
} from "./layoutWorkspace";
import type { LayoutEntry, Panel, PaneNode, Tab } from "@/types";

let seq = 0;

function tab(overrides: Partial<Tab> = {}): Tab {
  seq += 1;
  return {
    id: `tab-${seq}`,
    title: `tab-${seq}`,
    contentType: "terminal",
    projectId: `proj-${seq}`,
    projectPath: `/tmp/proj-${seq}`,
    sessionId: null,
    ...overrides,
  };
}

function panel(tabs: Tab[]): Panel {
  seq += 1;
  return {
    type: "panel",
    id: `pane-${seq}`,
    tabs,
    activeTabId: tabs[0]?.id ?? "",
  };
}

function layout(rootPane: PaneNode, overrides: Partial<LayoutEntry> = {}): LayoutEntry {
  seq += 1;
  return {
    id: `layout-${seq}`,
    name: `布局 ${seq}`,
    kind: "normal",
    rootPane,
    activePaneId: rootPane.id,
    ...overrides,
  };
}

describe("getLayoutWorkspaceBinding", () => {
  it("manual 绑定优先于标签推导", () => {
    const entry = layout(panel([tab({ workspaceName: "ws-derived" })]), {
      workspaceName: "ws-manual",
    });

    expect(getLayoutWorkspaceBinding(entry)).toEqual({
      workspaceName: "ws-manual",
      source: "manual",
    });
  });

  it("无 manual 时按深度优先第一个带 workspaceName 的 terminal tab 推导", () => {
    const left = panel([tab({ workspaceName: undefined }), tab({ workspaceName: "ws-a" })]);
    const right = panel([tab({ workspaceName: "ws-b" })]);
    const entry = layout({
      type: "split",
      id: "split-1",
      direction: "horizontal",
      children: [left, right],
      sizes: [50, 50],
    });

    expect(getLayoutWorkspaceBinding(entry)).toEqual({
      workspaceName: "ws-a",
      source: "derived",
    });
  });

  it("忽略非 terminal tab 与空白 workspaceName", () => {
    const entry = layout(panel([
      tab({ contentType: "editor", workspaceName: "ws-editor" }),
      tab({ workspaceName: "  " }),
      tab({ workspaceName: "ws-real" }),
    ]));

    expect(getLayoutWorkspaceBinding(entry)).toEqual({
      workspaceName: "ws-real",
      source: "derived",
    });
  });

  it("manual 为空白字符串时回落推导，全部缺失时返回 null", () => {
    const derived = layout(panel([tab({ workspaceName: "ws-a" })]), { workspaceName: "  " });
    expect(getLayoutWorkspaceBinding(derived)?.source).toBe("derived");

    const none = layout(panel([tab()]));
    expect(getLayoutWorkspaceBinding(none)).toBeNull();
  });
});

describe("findLayoutForWorkspace", () => {
  it("manual 命中优先于 derived，即使 derived 更近使用", () => {
    const derived = layout(panel([tab({ workspaceName: "ws-a" })]), { lastActiveAt: 200 });
    const manual = layout(panel([tab()]), { workspaceName: "ws-a", lastActiveAt: 100 });

    expect(findLayoutForWorkspace([derived, manual], "ws-a")).toBe(manual);
  });

  it("同源多个命中按 lastActiveAt 取最近，缺失视为 0", () => {
    const older = layout(panel([tab({ workspaceName: "ws-a" })]), { lastActiveAt: 100 });
    const newer = layout(panel([tab({ workspaceName: "ws-a" })]), { lastActiveAt: 300 });
    const untouched = layout(panel([tab({ workspaceName: "ws-a" })]));

    expect(findLayoutForWorkspace([older, untouched, newer], "ws-a")).toBe(newer);
    expect(findLayoutForWorkspace([untouched, older], "ws-a")).toBe(older);
  });

  it("过滤星标布局，且名称不匹配/空白目标返回 null", () => {
    const starred = layout(panel([tab({ workspaceName: "ws-a" })]), {
      kind: "starred",
      workspaceName: "ws-a",
    });
    const other = layout(panel([tab({ workspaceName: "ws-b" })]));

    expect(findLayoutForWorkspace([starred, other], "ws-a")).toBeNull();
    expect(findLayoutForWorkspace([other], "  ")).toBeNull();
  });
});

describe("resolveWorkspaceLaunchLayout", () => {
  it("当前普通布局未绑定时优先留在当前布局", () => {
    const previous = layout(panel([tab()]), { workspaceName: "ws-a" });
    const current = layout(panel([tab()]), { id: "layout-current" });

    expect(resolveWorkspaceLaunchLayout([previous, current], current.id, "ws-a")).toBe(current);
  });

  it("当前布局已匹配目标工作空间时保持当前布局", () => {
    const previous = layout(panel([tab()]), { workspaceName: "ws-a", lastActiveAt: 300 });
    const current = layout(panel([tab()]), {
      id: "layout-current",
      workspaceName: "ws-a",
      lastActiveAt: 100,
    });

    expect(resolveWorkspaceLaunchLayout([previous, current], current.id, "ws-a")).toBe(current);
  });

  it("当前布局绑定到其他工作空间时路由到匹配布局", () => {
    const target = layout(panel([tab()]), { workspaceName: "ws-a" });
    const current = layout(panel([tab()]), {
      id: "layout-current",
      workspaceName: "ws-b",
    });

    expect(resolveWorkspaceLaunchLayout([target, current], current.id, "ws-a")).toBe(target);
  });

  it("当前为星标布局时仍自动路由到匹配的普通布局", () => {
    const target = layout(panel([tab()]), { workspaceName: "ws-a" });
    const starred = layout(panel([tab()]), {
      id: "layout-starred",
      kind: "starred",
    });

    expect(resolveWorkspaceLaunchLayout([target, starred], starred.id, "ws-a")).toBe(target);
  });

  it("当前布局绑定冲突且没有匹配布局时留在当前布局", () => {
    const current = layout(panel([tab()]), {
      id: "layout-current",
      workspaceName: "ws-b",
    });

    expect(resolveWorkspaceLaunchLayout([current], current.id, "ws-a")).toBe(current);
  });
});

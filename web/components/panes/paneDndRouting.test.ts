import { describe, expect, it } from "vitest";
import { resolveDndDrop, type PaneDndContextData } from "./paneDndRouting";
import type { Tab } from "@/types";

const tab = (id: string) => ({ id, title: id }) as Tab;

const ctx: PaneDndContextData = {
  panels: [
    { id: "pane-1", tabs: [tab("t1"), tab("t2")] },
    { id: "pane-2", tabs: [tab("t3")] },
  ],
  layouts: [
    { id: "layout-1", kind: undefined },
    { id: "layout-2", kind: undefined },
    { id: "layout-star", kind: "starred" },
  ],
  currentLayoutId: "layout-1",
};

const tabNode = (id: string, paneId: string) => ({ id, data: { type: "tab", paneId } });
const layoutNode = (id: string) => ({ id, data: { type: "layout", layoutId: id } });

describe("resolveDndDrop", () => {
  it("tab 拖到 pane 右边缘 → 落边分屏（split-move-tab）", () => {
    const edgeNode = { id: "pane-edge-pane-2-right", data: { type: "pane-edge", paneId: "pane-2", edge: "right" } };
    expect(resolveDndDrop(tabNode("t1", "pane-1"), edgeNode, ctx)).toEqual({
      kind: "split-move-tab",
      fromPaneId: "pane-1",
      toPaneId: "pane-2",
      tabId: "t1",
      edge: "right",
    });
  });

  it("tab 拖到 pane 下边缘 → 落边分屏（edge=bottom）", () => {
    const edgeNode = { id: "pane-edge-pane-2-bottom", data: { type: "pane-edge", paneId: "pane-2", edge: "bottom" } };
    expect(resolveDndDrop(tabNode("t1", "pane-1"), edgeNode, ctx)).toEqual({
      kind: "split-move-tab",
      fromPaneId: "pane-1",
      toPaneId: "pane-2",
      tabId: "t1",
      edge: "bottom",
    });
  });

  it("tab 拖到不存在的 pane 边缘 → 拒绝", () => {
    const edgeNode = { id: "pane-edge-ghost-right", data: { type: "pane-edge", paneId: "ghost", edge: "right" } };
    expect(resolveDndDrop(tabNode("t1", "pane-1"), edgeNode, ctx)).toBeNull();
  });

  it("同 pane 内 tab→tab 是重排序", () => {
    expect(resolveDndDrop(tabNode("t1", "pane-1"), tabNode("t2", "pane-1"), ctx)).toEqual({
      kind: "reorder-tabs",
      paneId: "pane-1",
      fromIndex: 0,
      toIndex: 1,
    });
  });

  it("跨 pane 的 tab→tab 是移动，并带上落点索引", () => {
    expect(resolveDndDrop(tabNode("t1", "pane-1"), tabNode("t3", "pane-2"), ctx)).toEqual({
      kind: "move-tab",
      fromPaneId: "pane-1",
      toPaneId: "pane-2",
      tabId: "t1",
      toIndex: 0,
    });
  });

  it("tab 拖到别的布局 → 移动到该布局（不指定 pane，交给 store 取首个）", () => {
    expect(resolveDndDrop(tabNode("t1", "pane-1"), layoutNode("layout-2"), ctx)).toEqual({
      kind: "move-tab-to-layout",
      fromPaneId: "pane-1",
      tabId: "t1",
      toLayoutId: "layout-2",
    });
  });

  it("tab 拖到星标布局 → 拒绝（星标装不了终端 tab）", () => {
    expect(resolveDndDrop(tabNode("t1", "pane-1"), layoutNode("layout-star"), ctx)).toBeNull();
  });

  it("tab 拖到当前布局 → 拒绝（避免把 tab 意外挪到本布局首个 pane）", () => {
    expect(resolveDndDrop(tabNode("t1", "pane-1"), layoutNode("layout-1"), ctx)).toBeNull();
  });

  it("布局条内 layout→layout 仍是重排序（合并 context 后行为不变）", () => {
    expect(resolveDndDrop(layoutNode("layout-1"), layoutNode("layout-2"), ctx)).toEqual({
      kind: "reorder-layouts",
      fromIndex: 0,
      toIndex: 1,
    });
  });

  it("layout 拖到 tab 上 → 拒绝", () => {
    expect(resolveDndDrop(layoutNode("layout-1"), tabNode("t1", "pane-1"), ctx)).toBeNull();
  });

  it("over 为空或落回自身 → 拒绝", () => {
    expect(resolveDndDrop(tabNode("t1", "pane-1"), null, ctx)).toBeNull();
    expect(resolveDndDrop(tabNode("t1", "pane-1"), tabNode("t1", "pane-1"), ctx)).toBeNull();
  });

  it("非 tab/layout 的 active → 拒绝", () => {
    expect(
      resolveDndDrop({ id: "x", data: { type: "workspace" } }, tabNode("t1", "pane-1"), ctx),
    ).toBeNull();
  });
});

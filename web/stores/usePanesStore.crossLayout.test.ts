// 跨布局落位：leader 派 worker 时前端默认不再切布局（useOrchestratorListener），
// 但窗格必须仍建在**目标**布局里。这里锁住 addTab / openSessionBesidePane 的
// layoutId 参数语义——漏掉它 worker 就会插进用户正在看的布局。
import { beforeEach, describe, expect, it } from "vitest";
import { usePanesStore } from "./usePanesStore";
import { collectPanels, createPanel } from "./paneTreeHelpers";
import type { Panel } from "@/types";

function resetTwoLayouts() {
  const rootA = createPanel();
  const rootB = createPanel();
  usePanesStore.setState({
    rootPane: rootA,
    activePaneId: rootA.id,
    layouts: [
      { id: "layout-a", name: "布局 A", kind: "normal", rootPane: rootA, activePaneId: rootA.id },
      { id: "layout-b", name: "布局 B", kind: "normal", rootPane: rootB, activePaneId: rootB.id },
    ],
    currentLayoutId: "layout-a",
    closedTabs: [],
    poppedOutTabs: new Set<string>(),
  });
  return { rootA, rootB: rootB as Panel };
}

function layoutTreeOf(layoutId: string) {
  const state = usePanesStore.getState();
  const layout = state.layouts.find((item) => item.id === layoutId)!;
  return layoutId === state.currentLayoutId ? state.rootPane : layout.rootPane;
}

function projectPathsIn(layoutId: string): string[] {
  return collectPanels(layoutTreeOf(layoutId))
    .flatMap((pane) => pane.tabs)
    .map((tab) => tab.projectPath)
    .filter(Boolean);
}

describe("addTab / openSessionBesidePane 的 layoutId", () => {
  beforeEach(() => {
    resetTwoLayouts();
  });

  it("省略 layoutId 时写当前布局（向后兼容）", () => {
    const paneId = usePanesStore.getState().activePaneId;

    usePanesStore.getState().addTab(paneId, { projectId: "p", projectPath: "/tmp/here" });

    expect(projectPathsIn("layout-a")).toContain("/tmp/here");
    expect(projectPathsIn("layout-b")).not.toContain("/tmp/here");
    expect(usePanesStore.getState().currentLayoutId).toBe("layout-a");
  });

  it("addTab 带 layoutId 写进目标布局，且不切换当前布局", () => {
    const { rootB } = resetTwoLayouts();

    usePanesStore
      .getState()
      .addTab(rootB.id, { projectId: "p", projectPath: "/tmp/worker" }, "layout-b");

    expect(projectPathsIn("layout-b")).toContain("/tmp/worker");
    expect(projectPathsIn("layout-a")).not.toContain("/tmp/worker");
    // 关键：用户还停在原来的布局
    expect(usePanesStore.getState().currentLayoutId).toBe("layout-a");
  });

  it("openSessionBesidePane 带 layoutId 在目标布局里分屏，不动当前布局", () => {
    const { rootB } = resetTwoLayouts();
    // 目标 pane 非空才会真的分屏（空窗格会直接把会话开在里面）
    usePanesStore
      .getState()
      .addTab(rootB.id, { projectId: "p", projectPath: "/tmp/leader" }, "layout-b");

    usePanesStore
      .getState()
      .openSessionBesidePane(rootB.id, "right", { projectId: "p", projectPath: "/tmp/worker" }, "layout-b");

    const treeB = layoutTreeOf("layout-b");
    expect(treeB.type).toBe("split");
    expect(collectPanels(treeB)).toHaveLength(2);
    expect(projectPathsIn("layout-b")).toEqual(
      expect.arrayContaining(["/tmp/leader", "/tmp/worker"]),
    );
    expect(projectPathsIn("layout-a")).toHaveLength(0);
    expect(usePanesStore.getState().currentLayoutId).toBe("layout-a");
  });

  it("非当前布局的 active 写 layout.activePaneId，不污染 state.activePaneId", () => {
    const { rootA, rootB } = resetTwoLayouts();
    usePanesStore
      .getState()
      .addTab(rootB.id, { projectId: "p", projectPath: "/tmp/leader" }, "layout-b");

    usePanesStore
      .getState()
      .openSessionBesidePane(rootB.id, "right", { projectId: "p", projectPath: "/tmp/worker" }, "layout-b");

    const state = usePanesStore.getState();
    const layoutB = state.layouts.find((item) => item.id === "layout-b")!;
    expect(state.activePaneId).toBe(rootA.id);
    expect(layoutB.activePaneId).not.toBe(rootB.id);
    expect(collectPanels(layoutB.rootPane).map((p) => p.id)).toContain(layoutB.activePaneId);
  });

  it("目标布局不存在时退回当前布局，保证会话总能落地", () => {
    const paneId = usePanesStore.getState().activePaneId;

    usePanesStore
      .getState()
      .addTab(paneId, { projectId: "p", projectPath: "/tmp/orphan" }, "layout-missing");

    expect(projectPathsIn("layout-a")).toContain("/tmp/orphan");
    expect(usePanesStore.getState().currentLayoutId).toBe("layout-a");
  });
});

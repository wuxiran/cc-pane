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

// openBrowser / openEditor 的 layoutId：MCP 调用方所在布局。漏掉它，
// 别的布局里的 agent 打开页面/文件会飞到用户眼前的布局（用户报的「到处飞」）。
describe("openBrowser / openEditor 的 layoutId", () => {
  beforeEach(() => {
    resetTwoLayouts();
  });

  function tabIdsIn(layoutId: string): string[] {
    return collectPanels(layoutTreeOf(layoutId))
      .flatMap((pane) => pane.tabs)
      .map((tab) => tab.id);
  }

  it("openBrowser 带 layoutId 落到目标布局，不切当前布局", () => {
    usePanesStore
      .getState()
      .openBrowser("http://localhost:5173/", "Preview", "b1", { layoutId: "layout-b" });

    expect(tabIdsIn("layout-b")).toContain("b1");
    expect(tabIdsIn("layout-a")).not.toContain("b1");
    expect(usePanesStore.getState().currentLayoutId).toBe("layout-a");
  });

  it("openBrowser 的复用只在目标布局内查重，不跨布局把用户拽走", () => {
    const store = usePanesStore.getState();
    store.openBrowser("http://localhost:5173/app", "A", "b1");
    const created = store.openBrowser("http://localhost:5173/app", "B", "b2", {
      layoutId: "layout-b",
    });

    expect(created).toBe("b2");
    expect(tabIdsIn("layout-a")).toContain("b1");
    expect(tabIdsIn("layout-b")).toContain("b2");
  });

  it("openEditor 带 layoutId 落到目标布局，返回落点布局 id", () => {
    const landed = usePanesStore
      .getState()
      .openEditor("/tmp/proj", "/tmp/proj/a.ts", "a.ts", "layout-b");

    expect(landed).toBe("layout-b");
    expect(usePanesStore.getState().currentLayoutId).toBe("layout-a");
    const tabsB = collectPanels(layoutTreeOf("layout-b")).flatMap((pane) => pane.tabs);
    expect(tabsB.map((tab) => tab.filePath)).toContain("/tmp/proj/a.ts");
  });

  it("带 layoutId（MCP 路径）命中别的布局里的同名文件时不强切布局，只回报落点", () => {
    usePanesStore.getState().openEditor("/tmp/proj", "/tmp/proj/a.ts", "a.ts", "layout-b");

    // 调用方在 layout-a，但文件已开在 layout-b：聚焦原处，不把用户拽走
    const landed = usePanesStore
      .getState()
      .openEditor("/tmp/proj", "/tmp/proj/a.ts", "a.ts", "layout-a");

    expect(landed).toBe("layout-b");
    expect(usePanesStore.getState().currentLayoutId).toBe("layout-a");
    // 不得在当前布局再开一份（同文件双缓冲会互相覆盖）
    expect(
      collectPanels(layoutTreeOf("layout-a"))
        .flatMap((pane) => pane.tabs)
        .filter((tab) => tab.contentType === "editor"),
    ).toHaveLength(0);
  });

  it("不带 layoutId（用户在 UI 里点开）命中别的布局时仍切过去，保持「打开必可见」", () => {
    usePanesStore.getState().openEditor("/tmp/proj", "/tmp/proj/a.ts", "a.ts", "layout-b");

    const landed = usePanesStore.getState().openEditor("/tmp/proj", "/tmp/proj/a.ts", "a.ts");

    expect(landed).toBe("layout-b");
    expect(usePanesStore.getState().currentLayoutId).toBe("layout-b");
  });
});

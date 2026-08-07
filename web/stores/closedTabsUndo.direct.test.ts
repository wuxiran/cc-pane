// closedTabsUndo 的**直测**（0.12.0 发版闸门 QA）。
//
// 与既有两个文件的分工：
// - closedTabsUndo.test.ts 只测 trimClosedTabs；
// - closedTabsUndo.roundtrip.test.ts 走真实 store 端到端，只能覆盖「跑得通」的路径，
//   分支（reopenNonTerminalSnapshot 的四种落法、restoreClosedTabIdentity 的五种
//   早退）与「快照字段集是否漏了新字段」都够不着。
//
// 本文件补的是分支与**字段集双向锁**：ClosedTabSnapshot 新增字段而
// toClosedTabSnapshot 忘了映射，是纯粹的静默丢失——撤销出来的标签少一项配置，
// 所有既有断言照样绿。
import { describe, expect, it, vi } from "vitest";
import { produce } from "immer";

import {
  reopenNonTerminalSnapshot,
  restoreClosedTabIdentity,
  restoreClosedTabSplitTree,
  toClosedTabSnapshot,
} from "./closedTabsUndo";
import { TAB_LIFECYCLE } from "@/lib/tabLifecycle/registry";
import { DESTROY_POLICY, ALL_DESTROY_REASONS } from "@/lib/tabLifecycle/destroyPipeline";
import type { ClosedTabSnapshot } from "./panesStoreTypes";
import type { TerminalPaneNode } from "@/types";

/**
 * ClosedTabSnapshot 的**手写全集**。类型是 interface，运行时拿不到键集，
 * 只能手抄一份 + 双向比对（范式同 destroyPipeline 的 HANDWRITTEN_REASONS）。
 * 新增字段时这里会逼着同步，避免「加了字段但快照没存」。
 */
const SNAPSHOT_FIELDS = [
  "projectId",
  "projectPath",
  "title",
  "resumeId",
  "workspaceName",
  "providerId",
  "modelId",
  "providerSelection",
  "launchProfileId",
  "workspacePath",
  "workspaceSnapshotId",
  "launchClaude",
  "cliTool",
  "ssh",
  "wsl",
  "machineName",
  "pinned",
  "starred",
  "parentTabId",
  "launchExtras",
  "terminalRootPane",
  // 以下三个是非终端快照专用，由 registry 的 persistForUndo 产出，
  // toClosedTabSnapshot（终端专用映射）不负责。
  "contentType",
  "browserUrl",
  "filePath",
  "viewState",
] as const;

/** toClosedTabSnapshot 负责的字段子集（终端映射）。 */
const TERMINAL_MAPPED_FIELDS = SNAPSHOT_FIELDS.filter(
  (field) => !["contentType", "browserUrl", "filePath", "viewState"].includes(field),
);

const splitTree: TerminalPaneNode = {
  type: "split",
  id: "split-1",
  direction: "horizontal",
  sizes: [50, 50],
  children: [
    { type: "leaf", id: "leaf-a", sessionId: "live-a", cliTool: "claude" },
    { type: "leaf", id: "leaf-b", sessionId: null, savedSessionId: "saved-b" },
  ],
};

/** 每个可映射字段都给一个可辨识的非空值——漏映射会立刻显形。 */
function fullTerminalTab() {
  return {
    projectId: "proj-1",
    projectPath: "/tmp/p",
    title: "工作台",
    resumeId: "resume-1",
    workspaceName: "ws",
    providerId: "prov-1",
    modelId: "model-1",
    providerSelection: { providerId: "prov-1", modelId: "model-1" } as never,
    launchProfileId: "profile-1",
    workspacePath: "/ws",
    workspaceSnapshotId: "snap-1",
    launchClaude: true,
    cliTool: "claude" as const,
    ssh: { host: "h", user: "u" } as never,
    wsl: { distro: "Ubuntu", remotePath: "/mnt/d/p" },
    machineName: "box",
    pinned: true,
    starred: true,
    parentTabId: "tab-parent",
    launchExtras: { yolo: true, initialPrompt: "重构一下" },
    terminalRootPane: splitTree,
  };
}

describe("toClosedTabSnapshot：字段集双向锁", () => {
  it("每个可映射字段都被真的映射出来（新增字段忘了写这里会挂）", () => {
    const snap = toClosedTabSnapshot(fullTerminalTab());
    const produced = Object.keys(snap);

    const missing = TERMINAL_MAPPED_FIELDS.filter((field) => !produced.includes(field));
    expect(missing, `toClosedTabSnapshot 漏映射字段: ${missing.join(", ")}`).toEqual([]);
  });

  it("不产出手写全集之外的字段（新增字段必须同步手写表）", () => {
    const snap = toClosedTabSnapshot(fullTerminalTab());
    const extra = Object.keys(snap).filter(
      (key) => !(SNAPSHOT_FIELDS as readonly string[]).includes(key),
    );
    expect(extra, `快照多出未登记字段: ${extra.join(", ")}`).toEqual([]);
  });

  it("标量字段逐个原样带过", () => {
    const source = fullTerminalTab();
    const snap = toClosedTabSnapshot(source);
    expect({
      projectId: snap.projectId,
      projectPath: snap.projectPath,
      title: snap.title,
      resumeId: snap.resumeId,
      workspaceName: snap.workspaceName,
      providerId: snap.providerId,
      modelId: snap.modelId,
      launchProfileId: snap.launchProfileId,
      workspacePath: snap.workspacePath,
      workspaceSnapshotId: snap.workspaceSnapshotId,
      launchClaude: snap.launchClaude,
      cliTool: snap.cliTool,
      machineName: snap.machineName,
      pinned: snap.pinned,
      starred: snap.starred,
      parentTabId: snap.parentTabId,
    }).toEqual({
      projectId: "proj-1",
      projectPath: "/tmp/p",
      title: "工作台",
      resumeId: "resume-1",
      workspaceName: "ws",
      providerId: "prov-1",
      modelId: "model-1",
      launchProfileId: "profile-1",
      workspacePath: "/ws",
      workspaceSnapshotId: "snap-1",
      launchClaude: true,
      cliTool: "claude",
      machineName: "box",
      pinned: true,
      starred: true,
      parentTabId: "tab-parent",
    });
    expect(source).toBeDefined();
  });

  it("initialPrompt 在写快照时就剥掉（撤销出的会话不得重放首启 prompt）", () => {
    const snap = toClosedTabSnapshot(fullTerminalTab());
    expect(snap.launchExtras).toEqual({ yolo: true });
  });

  it("launchExtras 只有 initialPrompt 时整体归 undefined，不留空对象", () => {
    const snap = toClosedTabSnapshot({
      ...fullTerminalTab(),
      launchExtras: { initialPrompt: "只有它" },
    });
    expect(snap.launchExtras).toBeUndefined();
  });

  it("单格终端树不进快照（addTab 会自然建出一个 leaf）", () => {
    const snap = toClosedTabSnapshot({
      ...fullTerminalTab(),
      terminalRootPane: { type: "leaf", id: "solo", sessionId: "s" },
    });
    expect(snap.terminalRootPane).toBeUndefined();
  });

  it("无终端树时不抛且字段为 undefined", () => {
    const snap = toClosedTabSnapshot({
      projectId: "p",
      projectPath: "/p",
      title: "t",
    });
    expect(snap.terminalRootPane).toBeUndefined();
  });

  it("存入的分屏树已过重置清单：无活会话字段、id 全新", () => {
    const snap = toClosedTabSnapshot(fullTerminalTab());
    const root = snap.terminalRootPane!;
    expect(root.type).toBe("split");
    expect(root.id).not.toBe("split-1");

    const serialized = JSON.stringify(root);
    expect(serialized).not.toContain("live-a");
    expect(serialized).not.toContain("saved-b");
    expect(serialized).not.toContain("leaf-a");
  });
});

describe("toClosedTabSnapshot：Immer draft 逃逸", () => {
  // CLAUDE.md：从 draft 带出数据必须深拷贝。浅拷贝的嵌套对象在 producer 结束后
  // 是 revoked proxy，读它会抛——而**写快照时一切正常**，只有撤销那一刻才炸。
  it("producer 结束后快照的嵌套对象仍可读（ssh/wsl/providerSelection/launchExtras/树）", () => {
    const base = { tab: fullTerminalTab() };
    let snap!: ClosedTabSnapshot;

    produce(base, (draft) => {
      snap = toClosedTabSnapshot(draft.tab as never);
    });

    // 下面每一行在浅拷贝实现下都会抛 "proxy has been revoked"
    expect(() => JSON.stringify(snap.ssh)).not.toThrow();
    expect(snap.wsl).toEqual({ distro: "Ubuntu", remotePath: "/mnt/d/p" });
    expect(snap.providerSelection).toEqual({ providerId: "prov-1", modelId: "model-1" });
    expect(snap.launchExtras).toEqual({ yolo: true });
    expect(JSON.stringify(snap.terminalRootPane)).toContain("split");
  });

  it("快照与 draft 源不共享引用（改快照不回写、改源不影响快照）", () => {
    const base = { tab: fullTerminalTab() };
    let snap!: ClosedTabSnapshot;
    const next = produce(base, (draft) => {
      snap = toClosedTabSnapshot(draft.tab as never);
      draft.tab.wsl.distro = "Debian";
    });

    expect(next.tab.wsl.distro).toBe("Debian");
    expect(snap.wsl?.distro).toBe("Ubuntu");
  });
});

describe("reopenNonTerminalSnapshot（四分支）", () => {
  function makeStore() {
    return {
      openBrowser: vi.fn(() => "layout-1"),
      openEditor: vi.fn(() => "layout-1"),
      findEditorTabIdByPath: vi.fn(() => "new-tab-1"),
    };
  }

  const editorSnap: ClosedTabSnapshot = {
    contentType: "editor",
    projectId: "p",
    projectPath: "/p",
    title: "main.rs",
    filePath: "/p/src/main.rs",
    viewState: { editorCursor: { line: 42, column: 7 } },
  } as ClosedTabSnapshot;

  it("① browser + URL → openBrowser，返回 true", () => {
    const store = makeStore();
    const handled = reopenNonTerminalSnapshot(store, {
      contentType: "browser",
      projectId: "p",
      projectPath: "/p",
      title: "站点",
      browserUrl: "https://example.com",
    } as ClosedTabSnapshot);

    expect(handled).toBe(true);
    expect(store.openBrowser).toHaveBeenCalledWith("https://example.com", "站点");
    expect(store.openEditor).not.toHaveBeenCalled();
  });

  it("② browser 但无 URL → 不处理，返回 false（交回调用方走 addTab）", () => {
    const store = makeStore();
    const handled = reopenNonTerminalSnapshot(store, {
      contentType: "browser",
      projectId: "p",
      projectPath: "/p",
      title: "无 URL",
    } as ClosedTabSnapshot);

    expect(handled).toBe(false);
    expect(store.openBrowser).not.toHaveBeenCalled();
  });

  it("③ editor + filePath → openEditor 带 forcePaneTab（Files 视图下否则不建 pane tab）", () => {
    const store = makeStore();
    const handled = reopenNonTerminalSnapshot(store, editorSnap);

    expect(handled).toBe(true);
    expect(store.openEditor).toHaveBeenCalledWith("/p", "/p/src/main.rs", "main.rs", undefined, {
      forcePaneTab: true,
    });
  });

  it("④ terminal / 缺省 contentType → 返回 false", () => {
    const store = makeStore();
    expect(
      reopenNonTerminalSnapshot(store, {
        contentType: "terminal",
        projectId: "p",
        projectPath: "/p",
        title: "t",
      } as ClosedTabSnapshot),
    ).toBe(false);
    expect(
      reopenNonTerminalSnapshot(store, {
        projectId: "p",
        projectPath: "/p",
        title: "t",
      } as ClosedTabSnapshot),
    ).toBe(false);
  });

  it("editor 但无 filePath → 返回 false", () => {
    const store = makeStore();
    expect(
      reopenNonTerminalSnapshot(store, {
        contentType: "editor",
        projectId: "p",
        projectPath: "/p",
        title: "t",
      } as ClosedTabSnapshot),
    ).toBe(false);
  });

  it("editor 恢复视图状态用的是**新 tabId**，不是 openEditor 返回的 layoutId", () => {
    const store = makeStore();
    const onRestoreState = vi.spyOn(
      TAB_LIFECYCLE.editor as Required<typeof TAB_LIFECYCLE.editor>,
      "onRestoreState",
    );

    reopenNonTerminalSnapshot(store, editorSnap);

    expect(store.findEditorTabIdByPath).toHaveBeenCalledWith("/p/src/main.rs");
    expect(onRestoreState).toHaveBeenCalledWith(
      "new-tab-1",
      expect.objectContaining({ filePath: "/p/src/main.rs" }),
    );
    onRestoreState.mockRestore();
  });

  it("openEditor 返回 null（Files 视图）时不恢复视图状态，但仍算已处理", () => {
    const store = makeStore();
    store.openEditor.mockReturnValue(null as never);
    const onRestoreState = vi.spyOn(
      TAB_LIFECYCLE.editor as Required<typeof TAB_LIFECYCLE.editor>,
      "onRestoreState",
    );

    expect(reopenNonTerminalSnapshot(store, editorSnap)).toBe(true);
    expect(onRestoreState).not.toHaveBeenCalled();
    onRestoreState.mockRestore();
  });

  it("找不到新 tabId 时不恢复视图状态（宁可不恢复，也不记到不存在的标签名下）", () => {
    const store = makeStore();
    store.findEditorTabIdByPath.mockReturnValue(null as never);
    const onRestoreState = vi.spyOn(
      TAB_LIFECYCLE.editor as Required<typeof TAB_LIFECYCLE.editor>,
      "onRestoreState",
    );

    expect(reopenNonTerminalSnapshot(store, editorSnap)).toBe(true);
    expect(onRestoreState).not.toHaveBeenCalled();
    onRestoreState.mockRestore();
  });
});

describe("restoreClosedTabIdentity（五分支）", () => {
  function makeStore(pane: unknown) {
    return {
      findPaneById: vi.fn(() => pane as never),
      togglePinTab: vi.fn(),
      toggleStarTab: vi.fn(),
    };
  }

  const panel = { type: "panel", tabs: [{ id: "old" }, { id: "new-tab" }] };

  it("① pinned 与 starred 都没有 → 早退，连 findPaneById 都不调", () => {
    const store = makeStore(panel);
    restoreClosedTabIdentity(store, "pane-1", {});
    expect(store.findPaneById).not.toHaveBeenCalled();
  });

  it("② pane 不存在（null）→ 不打标记", () => {
    const store = makeStore(null);
    restoreClosedTabIdentity(store, "pane-1", { pinned: true });
    expect(store.togglePinTab).not.toHaveBeenCalled();
  });

  it("③ pane 不是 panel（split）→ 不打标记", () => {
    const store = makeStore({ type: "split", tabs: [{ id: "x" }] });
    restoreClosedTabIdentity(store, "pane-1", { pinned: true, starred: true });
    expect(store.togglePinTab).not.toHaveBeenCalled();
    expect(store.toggleStarTab).not.toHaveBeenCalled();
  });

  it("④ panel 无 tab → 不打标记（addTab 失败时不误标别的标签）", () => {
    const store = makeStore({ type: "panel", tabs: [] });
    restoreClosedTabIdentity(store, "pane-1", { pinned: true });
    expect(store.togglePinTab).not.toHaveBeenCalled();
  });

  it("⑤ 命中 → 在**最后一个** tab 上补打（addTab 恒 push 到末尾）", () => {
    const store = makeStore(panel);
    restoreClosedTabIdentity(store, "pane-1", { pinned: true, starred: true });
    expect(store.togglePinTab).toHaveBeenCalledWith("pane-1", "new-tab");
    expect(store.toggleStarTab).toHaveBeenCalledWith("new-tab");
  });

  it("只 pinned 时不误打 starred，反之亦然", () => {
    const pinnedOnly = makeStore(panel);
    restoreClosedTabIdentity(pinnedOnly, "pane-1", { pinned: true });
    expect(pinnedOnly.togglePinTab).toHaveBeenCalled();
    expect(pinnedOnly.toggleStarTab).not.toHaveBeenCalled();

    const starredOnly = makeStore(panel);
    restoreClosedTabIdentity(starredOnly, "pane-1", { starred: true });
    expect(starredOnly.togglePinTab).not.toHaveBeenCalled();
    expect(starredOnly.toggleStarTab).toHaveBeenCalled();
  });
});

describe("restoreClosedTabSplitTree", () => {
  const panel = { type: "panel", tabs: [{ id: "new-tab" }] };

  it("单格/无树快照不回放（addTab 已建出单格）", () => {
    const applyTree = vi.fn();
    restoreClosedTabSplitTree(applyTree, () => panel as never, "pane-1", {});
    restoreClosedTabSplitTree(applyTree, () => panel as never, "pane-1", {
      terminalRootPane: { type: "leaf", id: "solo", sessionId: null },
    });
    expect(applyTree).not.toHaveBeenCalled();
  });

  it("pane 非 panel / 无 tab 时不回放", () => {
    const applyTree = vi.fn();
    restoreClosedTabSplitTree(applyTree, () => null as never, "pane-1", {
      terminalRootPane: splitTree,
    });
    restoreClosedTabSplitTree(applyTree, () => ({ type: "panel", tabs: [] }) as never, "pane-1", {
      terminalRootPane: splitTree,
    });
    expect(applyTree).not.toHaveBeenCalled();
  });

  it("回放时再过一次重置：同一条快照重开两次不撞 leaf id", () => {
    const calls: Array<{ root: TerminalPaneNode; activeLeafId: string }> = [];
    const applyTree = vi.fn((_tabId: string, root: TerminalPaneNode, activeLeafId: string) => {
      calls.push({ root, activeLeafId });
    });

    restoreClosedTabSplitTree(applyTree, () => panel as never, "p", {
      terminalRootPane: splitTree,
    });
    restoreClosedTabSplitTree(applyTree, () => panel as never, "p", {
      terminalRootPane: splitTree,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].root.id).not.toBe(calls[1].root.id);
    expect(calls[0].activeLeafId).not.toBe(calls[1].activeLeafId);
    // activeLeafId 必须指向本次这棵树里的第一个 leaf
    expect(JSON.stringify(calls[0].root)).toContain(calls[0].activeLeafId);
  });
});

describe("撤销栈准入：recordsClosedTabs 与 pinned 豁免", () => {
  // 这两条是 DESTROY_POLICY 与撤销栈的接缝：矩阵改了但 push 点没跟上，表现为
  // 「自动化路径把标签塞进了撤销栈」或「用户关的标签撤销不回来」。
  it("recordsClosedTabs=false 的 reason 穷举：delete-layout / snapshot-apply / backend-close / editor-path-close", () => {
    const notRecorded = ALL_DESTROY_REASONS.filter(
      (reason) => !DESTROY_POLICY[reason].recordsClosedTabs,
    );
    expect([...notRecorded].sort()).toEqual([
      "backend-close",
      "delete-layout",
      "editor-path-close",
      "snapshot-apply",
    ]);
  });

  it("recordsClosedTabs=true 的 reason 恰是三条用户手动关闭路径", () => {
    const recorded = ALL_DESTROY_REASONS.filter(
      (reason) => DESTROY_POLICY[reason].recordsClosedTabs,
    );
    expect([...recorded].sort()).toEqual(["batch-close", "close-pane", "user-close"]);
  });

  it("记撤销的 reason 必然可否决（不可否决=自动化路径，塞进撤销栈会污染用户的栈）", () => {
    for (const reason of ALL_DESTROY_REASONS) {
      if (!DESTROY_POLICY[reason].recordsClosedTabs) continue;
      expect(DESTROY_POLICY[reason].vetoable, `${reason} 记撤销却不可否决`).toBe(true);
    }
  });
});

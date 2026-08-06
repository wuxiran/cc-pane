// onPersist / onRestoreState 的往返（docs/78 批4）。
import { beforeEach, describe, expect, it } from "vitest";

import { useEditorRevealStore } from "@/stores/useEditorRevealStore";
import { TAB_LIFECYCLE } from "./registry";
import {
  clearTabViewState,
  readTabViewState,
  reportTabViewState,
  resetTabViewStates,
  tabViewStateCount,
} from "./tabViewState";
import type { Tab } from "@/types";

function editorTab(id: string, filePath = "/p/src/main.rs"): Tab {
  return {
    id,
    title: "main.rs",
    contentType: "editor",
    projectId: "proj-1",
    projectPath: "/p",
    sessionId: null,
    filePath,
  };
}

beforeEach(() => {
  resetTabViewStates();
  useEditorRevealStore.getState().resetForTest();
});

describe("tabViewState", () => {
  it("上报是浅合并——各字段的上报点互不相干，整体覆盖会互相抹掉", () => {
    reportTabViewState("tab-1", { editorCursor: { line: 10, column: 3 } });
    reportTabViewState("tab-1", {});
    expect(readTabViewState("tab-1")?.editorCursor).toEqual({ line: 10, column: 3 });
  });

  it("无 tabId 时不记账（独立面板模式的 EditorView 没有 tabId）", () => {
    reportTabViewState("", { editorCursor: { line: 1, column: 1 } });
    expect(tabViewStateCount()).toBe(0);
  });

  it("clear 后读不到", () => {
    reportTabViewState("tab-1", { editorCursor: { line: 5, column: 1 } });
    clearTabViewState("tab-1");
    expect(readTabViewState("tab-1")).toBeUndefined();
    expect(tabViewStateCount()).toBe(0);
  });
});

describe("editor onPersist / onRestoreState", () => {
  it("onPersist 取走组件上报的光标", () => {
    reportTabViewState("tab-1", { editorCursor: { line: 42, column: 7 } });
    const persisted = TAB_LIFECYCLE.editor.onPersist?.(editorTab("tab-1"));
    expect(persisted?.editorCursor).toEqual({ line: 42, column: 7 });
  });

  it("persistForUndo 把光标一并带进撤销快照", () => {
    reportTabViewState("tab-1", { editorCursor: { line: 42, column: 7 } });
    const snap = TAB_LIFECYCLE.editor.persistForUndo?.(editorTab("tab-1"));
    expect(snap?.filePath).toBe("/p/src/main.rs");
    expect(snap?.viewState?.editorCursor).toEqual({ line: 42, column: 7 });
  });

  it("从未上报过光标时快照里没有 viewState，且不报错", () => {
    const snap = TAB_LIFECYCLE.editor.persistForUndo?.(editorTab("tab-never"));
    expect(snap?.viewState).toBeUndefined();
  });

  it("onRestoreState 发出 reveal 请求——EditorView 挂载后消费它跳回原光标", () => {
    TAB_LIFECYCLE.editor.onRestoreState?.("tab-new", {
      contentType: "editor",
      projectId: "proj-1",
      projectPath: "/p",
      title: "main.rs",
      filePath: "/p/src/main.rs",
      viewState: { editorCursor: { line: 42, column: 7 } },
    });

    const request = useEditorRevealStore.getState().requests["/p/src/main.rs"];
    expect(request).toBeTruthy();
    expect(request.line).toBe(42);
    expect(request.column).toBe(7);
    // 状态也记到新标签名下，供下一次关闭再取
    expect(readTabViewState("tab-new")?.editorCursor).toEqual({ line: 42, column: 7 });
  });

  it("没有光标的快照不发 reveal 请求（不劫持用户视图）", () => {
    TAB_LIFECYCLE.editor.onRestoreState?.("tab-new", {
      contentType: "editor",
      projectId: "proj-1",
      projectPath: "/p",
      title: "main.rs",
      filePath: "/p/src/main.rs",
    });
    expect(useEditorRevealStore.getState().requests["/p/src/main.rs"]).toBeUndefined();
  });

  it("关闭时清账——按 id 记账的 Map 必须有回收点，否则随开关标签无限增长", () => {
    reportTabViewState("tab-1", { editorCursor: { line: 1, column: 1 } });
    TAB_LIFECYCLE.editor.onClosed(editorTab("tab-1"), { detach: false, reason: "user-close" });
    expect(tabViewStateCount()).toBe(0);
  });
});

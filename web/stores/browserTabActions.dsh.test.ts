import { describe, expect, it } from "vitest";

import { createBrowserTabActions } from "./browserTabActions";

/**
 * openDsh 的参数传递守卫。
 *
 * 起因是一个**静默**缺陷：`workspacePath` 没传下来时，实例全部落到共享的
 * "default"，工作区自动注册整个跳过——界面上只表现为「左侧工作区是空的」，
 * 日志里连一次推送尝试都没有，很难看出是参数丢了而不是推送失败。
 */
function makePanel() {
  return { type: "panel", id: "pane-1", tabs: [], activeTabId: "" };
}

/**
 * 最小 store 替身。
 *
 * 必须带一条**正常布局**且 `currentLayoutId` 指向它：`resolveLayoutWriteTarget`
 * 会先经 `activateFirstNormalLayout` 找落点，没有布局时直接返回 null，
 * openDsh 什么都不做（表现为返回 null，看着像「建标签失败」）。
 */
function runOpenDsh(projectPath?: string, workspacePath?: string) {
  const panel = makePanel();
  const state = {
    rootPane: panel,
    currentLayoutId: "layout-1",
    activePaneId: "pane-1",
    layouts: [
      { id: "layout-1", name: "布局 1", kind: "normal", rootPane: panel, activePaneId: "pane-1" },
    ],
  };
  const actions = createBrowserTabActions((recipe) => {
    recipe(state as never);
  });
  const tabId = actions.openDsh(projectPath, workspacePath, { paneId: "pane-1" });
  return { tabId, tab: (state.rootPane.tabs as Array<Record<string, unknown>>)[0] };
}

describe("openDsh", () => {
  it("把 workspacePath 写进新标签——实例复用与工作区注册都靠它", () => {
    const { tab } = runOpenDsh("D:/proj", "D:/ws/demo");
    expect(tab.contentType).toBe("dsh");
    expect(tab.workspacePath).toBe("D:/ws/demo");
    expect(tab.projectPath).toBe("D:/proj");
  });

  it("不带 browserUrl——端口由 OS 分配，窗格起实例后才回填", () => {
    const { tab } = runOpenDsh("D:/proj", "D:/ws/demo");
    expect(tab.browserUrl).toBeUndefined();
  });

  it("无工作空间时仍可建标签（回落到 default 实例，不是报错）", () => {
    const { tabId, tab } = runOpenDsh(undefined, undefined);
    expect(tabId).toBeTruthy();
    expect(tab.workspacePath).toBeUndefined();
  });
});

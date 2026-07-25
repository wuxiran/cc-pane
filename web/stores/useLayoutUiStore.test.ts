import { beforeEach, describe, expect, it } from "vitest";
import { LAYOUT_UI_STORAGE_KEY, useLayoutUiStore } from "./useLayoutUiStore";

describe("useLayoutUiStore", () => {
  beforeEach(async () => {
    localStorage.clear();
    useLayoutUiStore.setState({
      switcherMode: "corner",
      layoutBarDensity: "comfortable",
      collapsedWorkspaceGroups: [],
    });
    await useLayoutUiStore.persist.rehydrate();
  });

  it("布局条密度默认使用舒适档", () => {
    expect(useLayoutUiStore.getInitialState().layoutBarDensity).toBe("comfortable");
  });

  it("切换布局条密度并持久化", () => {
    useLayoutUiStore.getState().setLayoutBarDensity("compact");

    expect(useLayoutUiStore.getState().layoutBarDensity).toBe("compact");
    expect(JSON.parse(localStorage.getItem(LAYOUT_UI_STORAGE_KEY) ?? "null")).toMatchObject({
      state: {
        switcherMode: "corner",
        layoutBarDensity: "compact",
      },
    });
  });

  it("切换工作空间分组折叠状态并持久化", () => {
    useLayoutUiStore.getState().toggleWorkspaceGroup("Backend");

    expect(useLayoutUiStore.getState().collapsedWorkspaceGroups).toEqual(["Backend"]);
    expect(JSON.parse(localStorage.getItem(LAYOUT_UI_STORAGE_KEY) ?? "null")).toMatchObject({
      state: {
        collapsedWorkspaceGroups: ["Backend"],
      },
    });

    useLayoutUiStore.getState().toggleWorkspaceGroup("Backend");
    expect(useLayoutUiStore.getState().collapsedWorkspaceGroups).toEqual([]);
  });
});

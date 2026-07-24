import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RIGHT_DOCK_WIDTH,
  MAX_RIGHT_DOCK_WIDTH,
  MIN_RIGHT_DOCK_WIDTH,
  RIGHT_DOCK_STORAGE_KEY,
  useRightDockStore,
} from "./useRightDockStore";

function resetStore() {
  useRightDockStore.setState({
    visible: false,
    activeView: "git",
    width: DEFAULT_RIGHT_DOCK_WIDTH,
  });
}

describe("useRightDockStore", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it("默认隐藏并以 Git 作为初始视图", () => {
    const state = useRightDockStore.getState();

    expect(state.visible).toBe(false);
    expect(state.activeView).toBe("git");
    expect(state.width).toBe(DEFAULT_RIGHT_DOCK_WIDTH);
  });

  it("切换视图时保持面板可见性不变", () => {
    useRightDockStore.getState().setVisible(true);
    useRightDockStore.getState().setActiveView("files");
    expect(useRightDockStore.getState()).toMatchObject({
      visible: true,
      activeView: "files",
    });

    useRightDockStore.getState().setVisible(false);
    useRightDockStore.getState().setActiveView("git");
    expect(useRightDockStore.getState()).toMatchObject({
      visible: false,
      activeView: "git",
    });
  });

  it("切换面板可见性时保留当前视图", () => {
    useRightDockStore.getState().setActiveView("files");

    useRightDockStore.getState().toggleVisible();
    expect(useRightDockStore.getState()).toMatchObject({ visible: true, activeView: "files" });

    useRightDockStore.getState().toggleVisible();
    expect(useRightDockStore.getState()).toMatchObject({ visible: false, activeView: "files" });
  });

  it("宽度始终钳制在允许范围内", () => {
    useRightDockStore.getState().setWidth(MIN_RIGHT_DOCK_WIDTH - 100);
    expect(useRightDockStore.getState().width).toBe(MIN_RIGHT_DOCK_WIDTH);

    useRightDockStore.getState().setWidth(MAX_RIGHT_DOCK_WIDTH + 100);
    expect(useRightDockStore.getState().width).toBe(MAX_RIGHT_DOCK_WIDTH);

    useRightDockStore.getState().setWidth(412);
    expect(useRightDockStore.getState().width).toBe(412);
  });

  it("启动时强制关闭，只恢复持久化的视图和宽度", async () => {
    useRightDockStore.setState({ visible: true, activeView: "git" });
    localStorage.setItem(
      RIGHT_DOCK_STORAGE_KEY,
      JSON.stringify({ state: { visible: true, activeView: "files", width: 428 }, version: 0 }),
    );

    await useRightDockStore.persist.rehydrate();

    expect(useRightDockStore.getState()).toMatchObject({
      visible: false,
      activeView: "files",
      width: 428,
    });
  });

  it("会话内打开面板时不把 visible 写入持久化数据", () => {
    useRightDockStore.getState().setVisible(true);

    const persisted = JSON.parse(localStorage.getItem(RIGHT_DOCK_STORAGE_KEY) ?? "{}");
    expect(persisted.state).toMatchObject({
      activeView: "git",
      width: DEFAULT_RIGHT_DOCK_WIDTH,
    });
    expect(persisted.state).not.toHaveProperty("visible");
  });
});

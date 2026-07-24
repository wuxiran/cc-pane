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

  it("切换到不同视图时展开，重复点击当前视图时折叠", () => {
    useRightDockStore.getState().toggleView("files");
    expect(useRightDockStore.getState()).toMatchObject({
      visible: true,
      activeView: "files",
    });

    useRightDockStore.getState().toggleView("files");
    expect(useRightDockStore.getState().visible).toBe(false);

    useRightDockStore.getState().toggleView("files");
    expect(useRightDockStore.getState().visible).toBe(true);
  });

  it("宽度始终钳制在允许范围内", () => {
    useRightDockStore.getState().setWidth(MIN_RIGHT_DOCK_WIDTH - 100);
    expect(useRightDockStore.getState().width).toBe(MIN_RIGHT_DOCK_WIDTH);

    useRightDockStore.getState().setWidth(MAX_RIGHT_DOCK_WIDTH + 100);
    expect(useRightDockStore.getState().width).toBe(MAX_RIGHT_DOCK_WIDTH);

    useRightDockStore.getState().setWidth(412);
    expect(useRightDockStore.getState().width).toBe(412);
  });

  it("只恢复持久化的可见性和宽度", async () => {
    useRightDockStore.setState({ activeView: "files" });
    localStorage.setItem(
      RIGHT_DOCK_STORAGE_KEY,
      JSON.stringify({ state: { visible: true, width: 428 }, version: 0 }),
    );

    await useRightDockStore.persist.rehydrate();

    expect(useRightDockStore.getState()).toMatchObject({
      visible: true,
      activeView: "files",
      width: 428,
    });
  });
});

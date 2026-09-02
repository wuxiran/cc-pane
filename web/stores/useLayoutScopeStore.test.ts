import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LAYOUT_SCOPE,
  LAYOUT_SCOPE_STORAGE_KEY,
  useLayoutScopeStore,
} from "./useLayoutScopeStore";
import type { LayoutSnapshotPayload } from "@/types";

const payload = (): LayoutSnapshotPayload => ({
  schemaVersion: 2,
  layouts: [{
    id: "layout-1",
    name: "布局 1",
    rootPane: {
      type: "panel",
      id: "pane-1",
      tabs: [],
      activeTabId: "",
    },
    activePaneId: "pane-1",
  }],
  currentLayoutId: "layout-1",
});

describe("useLayoutScopeStore", () => {
  beforeEach(() => {
    localStorage.removeItem(LAYOUT_SCOPE_STORAGE_KEY);
    useLayoutScopeStore.getState().resetForTest();
  });

  it("保存和读取时隔离 payload 引用", () => {
    const value = payload();
    useLayoutScopeStore.getState().saveScope("workspace:one", value);
    value.layouts[0]!.name = "changed";

    const loaded = useLayoutScopeStore.getState().getScope("workspace:one");
    expect(loaded?.layouts[0]?.name).toBe("布局 1");
    loaded!.layouts[0]!.name = "changed again";
    expect(useLayoutScopeStore.getState().getScope("workspace:one")?.layouts[0]?.name)
      .toBe("布局 1");
  });

  it("切换 activeScope 并支持 reset", () => {
    useLayoutScopeStore.getState().setActiveScope("ssh-machine:machine-1");
    expect(useLayoutScopeStore.getState().activeScope).toBe("ssh-machine:machine-1");
    useLayoutScopeStore.getState().reset();
    expect(useLayoutScopeStore.getState().activeScope).toBe(DEFAULT_LAYOUT_SCOPE);
    expect(useLayoutScopeStore.getState().getScope("ssh-machine:machine-1")).toBeUndefined();
  });
});

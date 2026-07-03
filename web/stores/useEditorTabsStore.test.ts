import { describe, it, expect, beforeEach } from "vitest";
import { useEditorTabsStore, type EditorTab } from "./useEditorTabsStore";

function makeTab(overrides: Partial<EditorTab> = {}): EditorTab {
  return {
    id: overrides.id ?? `tab-${Math.random().toString(36).slice(2)}`,
    title: overrides.title ?? "file.ts",
    filePath: overrides.filePath ?? "/proj/file.ts",
    projectPath: overrides.projectPath ?? "/proj",
    dirty: overrides.dirty ?? false,
    pinned: overrides.pinned,
  };
}

describe("useEditorTabsStore", () => {
  beforeEach(() => {
    useEditorTabsStore.setState({
      tabs: [],
      activeTabId: null,
      recentFiles: [],
    });
  });

  describe("初始状态", () => {
    it("应有空的 tabs、null 的 activeTabId 和空的 recentFiles", () => {
      const state = useEditorTabsStore.getState();
      expect(state.tabs).toEqual([]);
      expect(state.activeTabId).toBeNull();
      expect(state.recentFiles).toEqual([]);
    });
  });

  describe("openFile", () => {
    it("应新增标签并设为激活", () => {
      useEditorTabsStore.getState().openFile("/proj", "/proj/a.ts", "a.ts");

      const state = useEditorTabsStore.getState();
      expect(state.tabs).toHaveLength(1);
      expect(state.tabs[0].filePath).toBe("/proj/a.ts");
      expect(state.tabs[0].title).toBe("a.ts");
      expect(state.tabs[0].projectPath).toBe("/proj");
      expect(state.tabs[0].dirty).toBe(false);
      expect(state.activeTabId).toBe(state.tabs[0].id);
    });

    it("应把打开的文件记入最近文件历史", () => {
      useEditorTabsStore.getState().openFile("/proj", "/proj/a.ts", "a.ts");

      const recent = useEditorTabsStore.getState().recentFiles;
      expect(recent).toHaveLength(1);
      expect(recent[0].filePath).toBe("/proj/a.ts");
      expect(recent[0].projectPath).toBe("/proj");
      expect(recent[0].title).toBe("a.ts");
      expect(typeof recent[0].openedAt).toBe("number");
    });

    it("对同一 filePath 不重复创建标签，只切换激活", () => {
      const store = useEditorTabsStore.getState();
      store.openFile("/proj", "/proj/a.ts", "a.ts");
      store.openFile("/proj", "/proj/b.ts", "b.ts");
      const firstTabId = useEditorTabsStore.getState().tabs[0].id;

      // 再次打开 a.ts
      useEditorTabsStore.getState().openFile("/proj", "/proj/a.ts", "a.ts");

      const state = useEditorTabsStore.getState();
      expect(state.tabs).toHaveLength(2);
      expect(state.activeTabId).toBe(firstTabId);
    });

    it("重复打开同一文件时最近历史仍去重并置顶", () => {
      const store = useEditorTabsStore.getState();
      store.openFile("/proj", "/proj/a.ts", "a.ts");
      store.openFile("/proj", "/proj/b.ts", "b.ts");
      useEditorTabsStore.getState().openFile("/proj", "/proj/a.ts", "a.ts");

      const recent = useEditorTabsStore.getState().recentFiles;
      expect(recent).toHaveLength(2);
      expect(recent[0].filePath).toBe("/proj/a.ts");
      expect(recent[1].filePath).toBe("/proj/b.ts");
    });
  });

  describe("closeTab", () => {
    it("应移除指定标签", () => {
      const t1 = makeTab({ id: "t1" });
      const t2 = makeTab({ id: "t2", filePath: "/proj/2.ts" });
      useEditorTabsStore.setState({ tabs: [t1, t2], activeTabId: "t1" });

      useEditorTabsStore.getState().closeTab("t2");

      expect(useEditorTabsStore.getState().tabs.map((t) => t.id)).toEqual(["t1"]);
    });

    it("关闭激活标签后应激活相邻标签", () => {
      const t1 = makeTab({ id: "t1" });
      const t2 = makeTab({ id: "t2", filePath: "/proj/2.ts" });
      const t3 = makeTab({ id: "t3", filePath: "/proj/3.ts" });
      useEditorTabsStore.setState({ tabs: [t1, t2, t3], activeTabId: "t2" });

      useEditorTabsStore.getState().closeTab("t2");

      // idx=1，删除后取 min(1, len-1)=min(1,1)=1 → t3
      expect(useEditorTabsStore.getState().activeTabId).toBe("t3");
    });

    it("关闭最后一个标签应将 activeTabId 置为 null", () => {
      const t1 = makeTab({ id: "t1" });
      useEditorTabsStore.setState({ tabs: [t1], activeTabId: "t1" });

      useEditorTabsStore.getState().closeTab("t1");

      const state = useEditorTabsStore.getState();
      expect(state.tabs).toHaveLength(0);
      expect(state.activeTabId).toBeNull();
    });

    it("pinned 标签不可关闭", () => {
      const t1 = makeTab({ id: "t1", pinned: true });
      useEditorTabsStore.setState({ tabs: [t1], activeTabId: "t1" });

      useEditorTabsStore.getState().closeTab("t1");

      expect(useEditorTabsStore.getState().tabs).toHaveLength(1);
    });

    it("关闭非激活标签不改变 activeTabId", () => {
      const t1 = makeTab({ id: "t1" });
      const t2 = makeTab({ id: "t2", filePath: "/proj/2.ts" });
      useEditorTabsStore.setState({ tabs: [t1, t2], activeTabId: "t1" });

      useEditorTabsStore.getState().closeTab("t2");

      expect(useEditorTabsStore.getState().activeTabId).toBe("t1");
    });

    it("关闭不存在的标签为无操作", () => {
      const t1 = makeTab({ id: "t1" });
      useEditorTabsStore.setState({ tabs: [t1], activeTabId: "t1" });

      useEditorTabsStore.getState().closeTab("nope");

      expect(useEditorTabsStore.getState().tabs).toHaveLength(1);
    });
  });

  describe("closeOtherTabs", () => {
    it("应只保留目标标签和 pinned 标签", () => {
      const t1 = makeTab({ id: "t1" });
      const t2 = makeTab({ id: "t2", filePath: "/2", pinned: true });
      const t3 = makeTab({ id: "t3", filePath: "/3" });
      useEditorTabsStore.setState({ tabs: [t1, t2, t3], activeTabId: "t3" });

      useEditorTabsStore.getState().closeOtherTabs("t3");

      const ids = useEditorTabsStore.getState().tabs.map((t) => t.id);
      expect(ids).toEqual(["t2", "t3"]);
    });

    it("当激活标签被移除时应激活目标标签", () => {
      const t1 = makeTab({ id: "t1" });
      const t2 = makeTab({ id: "t2", filePath: "/2" });
      useEditorTabsStore.setState({ tabs: [t1, t2], activeTabId: "t1" });

      useEditorTabsStore.getState().closeOtherTabs("t2");

      expect(useEditorTabsStore.getState().activeTabId).toBe("t2");
    });
  });

  describe("closeTabsToRight", () => {
    it("应关闭目标右侧的非 pinned 标签", () => {
      const t1 = makeTab({ id: "t1" });
      const t2 = makeTab({ id: "t2", filePath: "/2" });
      const t3 = makeTab({ id: "t3", filePath: "/3", pinned: true });
      const t4 = makeTab({ id: "t4", filePath: "/4" });
      useEditorTabsStore.setState({ tabs: [t1, t2, t3, t4], activeTabId: "t2" });

      useEditorTabsStore.getState().closeTabsToRight("t2");

      const ids = useEditorTabsStore.getState().tabs.map((t) => t.id);
      expect(ids).toEqual(["t1", "t2", "t3"]);
    });

    it("目标不存在时为无操作", () => {
      const t1 = makeTab({ id: "t1" });
      useEditorTabsStore.setState({ tabs: [t1], activeTabId: "t1" });

      useEditorTabsStore.getState().closeTabsToRight("nope");

      expect(useEditorTabsStore.getState().tabs).toHaveLength(1);
    });

    it("激活标签被移除时应激活目标标签", () => {
      const t1 = makeTab({ id: "t1" });
      const t2 = makeTab({ id: "t2", filePath: "/2" });
      useEditorTabsStore.setState({ tabs: [t1, t2], activeTabId: "t2" });

      useEditorTabsStore.getState().closeTabsToRight("t1");

      expect(useEditorTabsStore.getState().activeTabId).toBe("t1");
    });
  });

  describe("closeTabsToLeft", () => {
    it("应关闭目标左侧的非 pinned 标签", () => {
      const t1 = makeTab({ id: "t1" });
      const t2 = makeTab({ id: "t2", filePath: "/2", pinned: true });
      const t3 = makeTab({ id: "t3", filePath: "/3" });
      useEditorTabsStore.setState({ tabs: [t1, t2, t3], activeTabId: "t3" });

      useEditorTabsStore.getState().closeTabsToLeft("t3");

      const ids = useEditorTabsStore.getState().tabs.map((t) => t.id);
      expect(ids).toEqual(["t2", "t3"]);
    });

    it("目标不存在时为无操作", () => {
      const t1 = makeTab({ id: "t1" });
      useEditorTabsStore.setState({ tabs: [t1], activeTabId: "t1" });

      useEditorTabsStore.getState().closeTabsToLeft("nope");

      expect(useEditorTabsStore.getState().tabs).toHaveLength(1);
    });

    it("激活标签被移除时应激活目标标签", () => {
      const t1 = makeTab({ id: "t1" });
      const t2 = makeTab({ id: "t2", filePath: "/2" });
      useEditorTabsStore.setState({ tabs: [t1, t2], activeTabId: "t1" });

      useEditorTabsStore.getState().closeTabsToLeft("t2");

      expect(useEditorTabsStore.getState().activeTabId).toBe("t2");
    });
  });

  describe("togglePin", () => {
    it("应切换 pinned 状态", () => {
      const t1 = makeTab({ id: "t1" });
      useEditorTabsStore.setState({ tabs: [t1], activeTabId: "t1" });

      useEditorTabsStore.getState().togglePin("t1");
      expect(useEditorTabsStore.getState().tabs[0].pinned).toBe(true);

      useEditorTabsStore.getState().togglePin("t1");
      expect(useEditorTabsStore.getState().tabs[0].pinned).toBe(false);
    });

    it("对不存在的标签为无操作", () => {
      const t1 = makeTab({ id: "t1" });
      useEditorTabsStore.setState({ tabs: [t1], activeTabId: "t1" });

      expect(() => useEditorTabsStore.getState().togglePin("nope")).not.toThrow();
      expect(useEditorTabsStore.getState().tabs[0].pinned).toBeUndefined();
    });
  });

  describe("selectTab", () => {
    it("应更新 activeTabId", () => {
      useEditorTabsStore.getState().selectTab("xyz");
      expect(useEditorTabsStore.getState().activeTabId).toBe("xyz");
    });
  });

  describe("setDirty", () => {
    it("应更新指定标签的 dirty 标记", () => {
      const t1 = makeTab({ id: "t1" });
      useEditorTabsStore.setState({ tabs: [t1], activeTabId: "t1" });

      useEditorTabsStore.getState().setDirty("t1", true);
      expect(useEditorTabsStore.getState().tabs[0].dirty).toBe(true);

      useEditorTabsStore.getState().setDirty("t1", false);
      expect(useEditorTabsStore.getState().tabs[0].dirty).toBe(false);
    });

    it("对不存在的标签为无操作", () => {
      useEditorTabsStore.setState({ tabs: [], activeTabId: null });
      expect(() => useEditorTabsStore.getState().setDirty("nope", true)).not.toThrow();
    });
  });

  describe("reorderTabs", () => {
    it("应移动标签顺序", () => {
      const t1 = makeTab({ id: "t1" });
      const t2 = makeTab({ id: "t2", filePath: "/2" });
      const t3 = makeTab({ id: "t3", filePath: "/3" });
      useEditorTabsStore.setState({ tabs: [t1, t2, t3], activeTabId: "t1" });

      useEditorTabsStore.getState().reorderTabs(0, 2);

      expect(useEditorTabsStore.getState().tabs.map((t) => t.id)).toEqual([
        "t2",
        "t3",
        "t1",
      ]);
    });

    it("fromIndex 越界时为无操作", () => {
      const t1 = makeTab({ id: "t1" });
      const t2 = makeTab({ id: "t2", filePath: "/2" });
      useEditorTabsStore.setState({ tabs: [t1, t2], activeTabId: "t1" });

      useEditorTabsStore.getState().reorderTabs(5, 0);

      expect(useEditorTabsStore.getState().tabs.map((t) => t.id)).toEqual(["t1", "t2"]);
    });

    it("toIndex 越界时为无操作", () => {
      const t1 = makeTab({ id: "t1" });
      const t2 = makeTab({ id: "t2", filePath: "/2" });
      useEditorTabsStore.setState({ tabs: [t1, t2], activeTabId: "t1" });

      useEditorTabsStore.getState().reorderTabs(0, 5);

      expect(useEditorTabsStore.getState().tabs.map((t) => t.id)).toEqual(["t1", "t2"]);
    });
  });

  describe("activeTab", () => {
    it("应返回当前激活的标签", () => {
      const t1 = makeTab({ id: "t1" });
      const t2 = makeTab({ id: "t2", filePath: "/2" });
      useEditorTabsStore.setState({ tabs: [t1, t2], activeTabId: "t2" });

      expect(useEditorTabsStore.getState().activeTab()).toEqual(t2);
    });

    it("没有激活标签时返回 undefined", () => {
      useEditorTabsStore.setState({ tabs: [], activeTabId: null });
      expect(useEditorTabsStore.getState().activeTab()).toBeUndefined();
    });
  });

  describe("addRecent", () => {
    it("应把最新文件置于列表最前", () => {
      const store = useEditorTabsStore.getState();
      store.addRecent({ filePath: "/a", projectPath: "/p", title: "a", openedAt: 1 });
      store.addRecent({ filePath: "/b", projectPath: "/p", title: "b", openedAt: 2 });

      const recent = useEditorTabsStore.getState().recentFiles;
      expect(recent.map((r) => r.filePath)).toEqual(["/b", "/a"]);
    });

    it("对相同 filePath 去重并置顶", () => {
      const store = useEditorTabsStore.getState();
      store.addRecent({ filePath: "/a", projectPath: "/p", title: "a", openedAt: 1 });
      store.addRecent({ filePath: "/b", projectPath: "/p", title: "b", openedAt: 2 });
      store.addRecent({ filePath: "/a", projectPath: "/p", title: "a2", openedAt: 3 });

      const recent = useEditorTabsStore.getState().recentFiles;
      expect(recent.map((r) => r.filePath)).toEqual(["/a", "/b"]);
      expect(recent[0].title).toBe("a2");
    });

    it("最多保留 30 条记录", () => {
      const store = useEditorTabsStore.getState();
      for (let i = 0; i < 40; i++) {
        store.addRecent({
          filePath: `/file-${i}`,
          projectPath: "/p",
          title: `f${i}`,
          openedAt: i,
        });
      }

      const recent = useEditorTabsStore.getState().recentFiles;
      expect(recent).toHaveLength(30);
      // 最新的 /file-39 在最前
      expect(recent[0].filePath).toBe("/file-39");
      // 最旧保留到 /file-10
      expect(recent[29].filePath).toBe("/file-10");
    });
  });

  describe("clearRecent", () => {
    it("应清空最近文件历史", () => {
      useEditorTabsStore.setState({
        recentFiles: [{ filePath: "/a", projectPath: "/p", title: "a", openedAt: 1 }],
      });

      useEditorTabsStore.getState().clearRecent();

      expect(useEditorTabsStore.getState().recentFiles).toEqual([]);
    });
  });
});

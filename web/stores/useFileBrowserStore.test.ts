import { describe, it, expect, beforeEach } from "vitest";
import { useFileBrowserStore } from "./useFileBrowserStore";

describe("useFileBrowserStore", () => {
  beforeEach(() => {
    useFileBrowserStore.setState({
      currentPath: "",
      history: [],
      historyIndex: -1,
      refreshKey: 0,
      followTerminal: true,
    });
  });

  describe("初始状态", () => {
    it("应该有正确的初始值", () => {
      const state = useFileBrowserStore.getState();
      expect(state.currentPath).toBe("");
      expect(state.history).toEqual([]);
      expect(state.historyIndex).toBe(-1);
      expect(state.refreshKey).toBe(0);
    });
  });

  describe("navigateTo", () => {
    it("应该导航到指定路径并记录历史", () => {
      useFileBrowserStore.getState().navigateTo("/home/user");
      const state = useFileBrowserStore.getState();
      expect(state.currentPath).toBe("/home/user");
      expect(state.history).toEqual(["/home/user"]);
      expect(state.historyIndex).toBe(0);
    });

    it("应该规范化反斜杠与去除尾部斜杠", () => {
      useFileBrowserStore.getState().navigateTo("C:\\Users\\test\\");
      expect(useFileBrowserStore.getState().currentPath).toBe("C:/Users/test");
    });

    it("导航到相同路径时应忽略", () => {
      const store = useFileBrowserStore.getState();
      store.navigateTo("/a");
      store.navigateTo("/a");
      const state = useFileBrowserStore.getState();
      expect(state.history).toEqual(["/a"]);
      expect(state.historyIndex).toBe(0);
    });

    it("在历史中间导航时应截断 forward 历史", () => {
      const store = useFileBrowserStore.getState();
      store.navigateTo("/a");
      store.navigateTo("/b");
      store.navigateTo("/c");
      // 回退两步到 /a
      useFileBrowserStore.getState().goBack();
      useFileBrowserStore.getState().goBack();
      expect(useFileBrowserStore.getState().currentPath).toBe("/a");
      // 从 /a 导航到新路径，应截断 /b /c
      useFileBrowserStore.getState().navigateTo("/d");
      const state = useFileBrowserStore.getState();
      expect(state.history).toEqual(["/a", "/d"]);
      expect(state.historyIndex).toBe(1);
    });
  });

  describe("persisted navigation migration", () => {
    it("rehydrates and upgrades a legacy bare drive root before the browser consumes it", async () => {
      localStorage.setItem("cc-panes-file-browser", JSON.stringify({
        version: 0, state: { currentPath: "C:", followTerminal: false },
      }));
      await useFileBrowserStore.persist.rehydrate();
      expect(useFileBrowserStore.getState().currentPath).toBe("C:/");
      expect(useFileBrowserStore.getState().followTerminal).toBe(false);
      expect(JSON.parse(localStorage.getItem("cc-panes-file-browser")!)).toEqual({
        version: 1, state: { currentPath: "C:/", followTerminal: false },
      });
      useFileBrowserStore.getState().goUp();
      expect(useFileBrowserStore.getState().currentPath).toBe("C:/");
    });

    it.each([
      [0, "C:foo", "C:foo"],
      [1, "C:", "C:"],
      [0, "D://work/", "D:/work"],
      [0, "/srv/a\\b/", "/srv/a\\b"],
      [0, "ssh://User@Host:22/srv/a\\b/", "ssh://User@Host:22/srv/a\\b"],
      [0, "\\\\server\\share\\", "//server/share"],
      [0, "/", "/"],
    ])("rehydrates version %s path %s without changing its root kind", async (version, path, expected) => {
      localStorage.setItem("cc-panes-file-browser", JSON.stringify({
        version, state: { currentPath: path, followTerminal: true },
      }));
      await useFileBrowserStore.persist.rehydrate();
      expect(useFileBrowserStore.getState().currentPath).toBe(expected);
      expect(useFileBrowserStore.getState().followTerminal).toBe(true);
    });
  });

  describe("goBack / goForward", () => {
    it("goBack 应回退到上一个路径", () => {
      const store = useFileBrowserStore.getState();
      store.navigateTo("/a");
      store.navigateTo("/b");
      useFileBrowserStore.getState().goBack();
      const state = useFileBrowserStore.getState();
      expect(state.currentPath).toBe("/a");
      expect(state.historyIndex).toBe(0);
    });

    it("在历史起点时 goBack 应无效", () => {
      useFileBrowserStore.getState().navigateTo("/a");
      useFileBrowserStore.getState().goBack();
      expect(useFileBrowserStore.getState().currentPath).toBe("/a");
      expect(useFileBrowserStore.getState().historyIndex).toBe(0);
    });

    it("goForward 应前进到下一个路径", () => {
      const store = useFileBrowserStore.getState();
      store.navigateTo("/a");
      store.navigateTo("/b");
      useFileBrowserStore.getState().goBack();
      useFileBrowserStore.getState().goForward();
      expect(useFileBrowserStore.getState().currentPath).toBe("/b");
      expect(useFileBrowserStore.getState().historyIndex).toBe(1);
    });

    it("在历史末尾时 goForward 应无效", () => {
      useFileBrowserStore.getState().navigateTo("/a");
      useFileBrowserStore.getState().goForward();
      expect(useFileBrowserStore.getState().currentPath).toBe("/a");
    });
  });

  describe("goUp", () => {
    it("应导航到父目录", () => {
      useFileBrowserStore.getState().navigateTo("/home/user/docs");
      useFileBrowserStore.getState().goUp();
      expect(useFileBrowserStore.getState().currentPath).toBe("/home/user");
    });

    it("currentPath 为空时应无效", () => {
      useFileBrowserStore.getState().goUp();
      expect(useFileBrowserStore.getState().currentPath).toBe("");
      expect(useFileBrowserStore.getState().history).toEqual([]);
    });

    it("Windows 路径应逐级回退，最终到盘符根", () => {
      useFileBrowserStore.getState().navigateTo("C:/Users/test");
      useFileBrowserStore.getState().goUp();
      expect(useFileBrowserStore.getState().currentPath).toBe("C:/Users");
      useFileBrowserStore.getState().goUp();
      expect(useFileBrowserStore.getState().currentPath).toBe("C:/");
      useFileBrowserStore.getState().goUp();
      expect(useFileBrowserStore.getState().currentPath).toBe("C:/");
    });

    it("父目录等于当前路径时不再导航", () => {
      // 无分隔符且不以 / 开头的路径，其父目录等于自身
      useFileBrowserStore.setState({
        currentPath: "foo",
        history: ["foo"],
        historyIndex: 0,
      });
      useFileBrowserStore.getState().goUp();
      const state = useFileBrowserStore.getState();
      expect(state.currentPath).toBe("foo");
      expect(state.history).toEqual(["foo"]);
    });
  });

  it("retains drive roots through navigation history and deduplicates root separators", () => {
    const store = useFileBrowserStore.getState();
    store.navigateTo("C:\\");
    store.navigateTo("C:/");
    store.navigateTo("C:/work");
    store.goBack();
    expect(useFileBrowserStore.getState().currentPath).toBe("C:/");
    expect(useFileBrowserStore.getState().history).toEqual(["C:/", "C:/work"]);
    store.goForward();
    expect(useFileBrowserStore.getState().currentPath).toBe("C:/work");
  });

  it("never navigates above a UNC share root when going up", () => {
    const store = useFileBrowserStore.getState();
    store.navigateTo("\\\\server\\share\\work");
    store.goUp();
    expect(useFileBrowserStore.getState().currentPath).toBe("//server/share");
    store.goUp();
    expect(useFileBrowserStore.getState().currentPath).toBe("//server/share");
    expect(useFileBrowserStore.getState().history).toEqual(["//server/share/work", "//server/share"]);
  });

  it("keeps POSIX literal backslashes in directories", () => {
    const store = useFileBrowserStore.getState();
    store.navigateTo("/srv/a\\b/child");
    store.goUp();
    expect(useFileBrowserStore.getState().currentPath).toBe("/srv/a\\b");
  });

  describe("refresh", () => {
    it("应递增 refreshKey", () => {
      useFileBrowserStore.getState().refresh();
      expect(useFileBrowserStore.getState().refreshKey).toBe(1);
      useFileBrowserStore.getState().refresh();
      expect(useFileBrowserStore.getState().refreshKey).toBe(2);
    });
  });

  describe("followTerminal", () => {
    it("默认开启并可切换", () => {
      expect(useFileBrowserStore.getState().followTerminal).toBe(true);

      useFileBrowserStore.getState().setFollowTerminal(false);
      expect(useFileBrowserStore.getState().followTerminal).toBe(false);

      useFileBrowserStore.getState().setFollowTerminal(true);
      expect(useFileBrowserStore.getState().followTerminal).toBe(true);
    });
  });

  describe("canGoBack / canGoForward", () => {
    it("初始时都应为 false", () => {
      expect(useFileBrowserStore.getState().canGoBack()).toBe(false);
      expect(useFileBrowserStore.getState().canGoForward()).toBe(false);
    });

    it("有历史时 canGoBack 为 true", () => {
      useFileBrowserStore.getState().navigateTo("/a");
      useFileBrowserStore.getState().navigateTo("/b");
      expect(useFileBrowserStore.getState().canGoBack()).toBe(true);
      expect(useFileBrowserStore.getState().canGoForward()).toBe(false);
    });

    it("回退后 canGoForward 为 true", () => {
      useFileBrowserStore.getState().navigateTo("/a");
      useFileBrowserStore.getState().navigateTo("/b");
      useFileBrowserStore.getState().goBack();
      expect(useFileBrowserStore.getState().canGoForward()).toBe(true);
    });
  });
});

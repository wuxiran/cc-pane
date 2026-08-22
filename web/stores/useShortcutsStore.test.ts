import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  useShortcutsStore,
  parseKeyEvent,
  formatKeyCombo,
  hasModifier,
  findConflict,
  handleKeydown,
  shouldTerminalHandleKey,
  isTerminalPassthroughAction,
} from "./useShortcutsStore";
import { useSettingsStore } from "./useSettingsStore";

// mock settingsService 以避免 useSettingsStore 初始化问题
vi.mock("@/services", () => ({
  settingsService: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
  },
}));

/**
 * 创建模拟 KeyboardEvent 的工厂函数
 */
function createKeyEvent(
  key: string,
  options: {
    ctrlKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
    /** 物理键位。mac 上按住 Option 时 key 会变成组字符（⌥L→"¬"），只能靠它还原 */
    code?: string;
  } = {}
): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key,
    code: options.code ?? "",
    ctrlKey: options.ctrlKey ?? false,
    shiftKey: options.shiftKey ?? false,
    altKey: options.altKey ?? false,
    metaKey: options.metaKey ?? false,
    bubbles: true,
    cancelable: true,
  });
}

describe("useShortcutsStore", () => {
  beforeEach(() => {
    useShortcutsStore.setState({
      actions: new Map(),
      terminalFocused: false,
    });
    useSettingsStore.setState({
      settings: null,
      loading: false,
    });
  });

  // ===========================================================================
  // parseKeyEvent
  // ===========================================================================
  describe("parseKeyEvent", () => {
    it("Ctrl+A 应返回 'Ctrl+A'", () => {
      const e = createKeyEvent("a", { ctrlKey: true });
      expect(parseKeyEvent(e)).toBe("Ctrl+A");
    });

    it("Meta+A 也应返回 'Ctrl+A'（Meta 映射为 Ctrl）", () => {
      const e = createKeyEvent("a", { metaKey: true });
      expect(parseKeyEvent(e)).toBe("Ctrl+A");
    });

    it("Shift+Tab 应返回 'Shift+Tab'", () => {
      const e = createKeyEvent("Tab", { shiftKey: true });
      expect(parseKeyEvent(e)).toBe("Shift+Tab");
    });

    it("Ctrl+Shift+Tab 应返回 'Ctrl+Shift+Tab'", () => {
      const e = createKeyEvent("Tab", { ctrlKey: true, shiftKey: true });
      expect(parseKeyEvent(e)).toBe("Ctrl+Shift+Tab");
    });

    it("F11 应返回 'F11'", () => {
      const e = createKeyEvent("F11");
      expect(parseKeyEvent(e)).toBe("F11");
    });

    it("F1 应返回 'F1'", () => {
      const e = createKeyEvent("F1");
      expect(parseKeyEvent(e)).toBe("F1");
    });

    it("纯修饰键（Control）应返回空字符串", () => {
      const e = createKeyEvent("Control", { ctrlKey: true });
      expect(parseKeyEvent(e)).toBe("");
    });

    it("纯修饰键（Shift）应返回空字符串", () => {
      const e = createKeyEvent("Shift", { shiftKey: true });
      expect(parseKeyEvent(e)).toBe("");
    });

    it("纯修饰键（Alt）应返回空字符串", () => {
      const e = createKeyEvent("Alt", { altKey: true });
      expect(parseKeyEvent(e)).toBe("");
    });

    it("纯修饰键（Meta）应返回空字符串", () => {
      const e = createKeyEvent("Meta", { metaKey: true });
      expect(parseKeyEvent(e)).toBe("");
    });

    it("空格键应返回 'Space'", () => {
      const e = createKeyEvent(" ");
      expect(parseKeyEvent(e)).toBe("Space");
    });

    it("Ctrl+空格 应返回 'Ctrl+Space'", () => {
      const e = createKeyEvent(" ", { ctrlKey: true });
      expect(parseKeyEvent(e)).toBe("Ctrl+Space");
    });

    it("特殊键映射：Escape", () => {
      const e = createKeyEvent("Escape");
      expect(parseKeyEvent(e)).toBe("Escape");
    });

    it("特殊键映射：Enter", () => {
      const e = createKeyEvent("Enter");
      expect(parseKeyEvent(e)).toBe("Enter");
    });

    it("特殊键映射：ArrowUp → Up", () => {
      const e = createKeyEvent("ArrowUp");
      expect(parseKeyEvent(e)).toBe("Up");
    });

    it("特殊键映射：ArrowDown → Down", () => {
      const e = createKeyEvent("ArrowDown");
      expect(parseKeyEvent(e)).toBe("Down");
    });

    it("Alt+ArrowLeft 应返回 'Alt+Left'", () => {
      const e = createKeyEvent("ArrowLeft", { altKey: true });
      expect(parseKeyEvent(e)).toBe("Alt+Left");
    });

    it("Alt+数字 应正确处理", () => {
      const e = createKeyEvent("1", { altKey: true });
      expect(parseKeyEvent(e)).toBe("Alt+1");
    });

    it("逗号键 应返回 ','", () => {
      const e = createKeyEvent(",");
      expect(parseKeyEvent(e)).toBe(",");
    });

    it("Ctrl+逗号 应返回 'Ctrl+,'", () => {
      const e = createKeyEvent(",", { ctrlKey: true });
      expect(parseKeyEvent(e)).toBe("Ctrl+,");
    });

    it("反斜杠键 应返回 '\\\\'", () => {
      const e = createKeyEvent("\\");
      expect(parseKeyEvent(e)).toBe("\\");
    });

    it("Ctrl+反斜杠 应返回 'Ctrl+\\\\'", () => {
      const e = createKeyEvent("\\", { ctrlKey: true });
      expect(parseKeyEvent(e)).toBe("Ctrl+\\");
    });
  });

  // ===========================================================================
  // formatKeyCombo
  // ===========================================================================
  describe("formatKeyCombo", () => {
    it("非 Mac 平台应原样返回", () => {
      // jsdom 默认 navigator.platform 不包含 MAC
      expect(formatKeyCombo("Ctrl+B")).toBe("Ctrl+B");
    });

    it("非 Mac 平台保留 Shift 和 Alt", () => {
      expect(formatKeyCombo("Ctrl+Shift+Tab")).toBe("Ctrl+Shift+Tab");
      expect(formatKeyCombo("Alt+F4")).toBe("Alt+F4");
    });
  });

  // ===========================================================================
  // hasModifier
  // ===========================================================================
  describe("hasModifier", () => {
    it("包含 Ctrl+ 应返回 true", () => {
      expect(hasModifier("Ctrl+A")).toBe(true);
    });

    it("包含 Shift+ 应返回 true", () => {
      expect(hasModifier("Shift+Tab")).toBe(true);
    });

    it("包含 Alt+ 应返回 true", () => {
      expect(hasModifier("Alt+F4")).toBe(true);
    });

    it("F 开头应返回 true", () => {
      expect(hasModifier("F11")).toBe(true);
      expect(hasModifier("F1")).toBe(true);
    });

    it("无修饰键应返回 false", () => {
      expect(hasModifier("A")).toBe(false);
      expect(hasModifier("Space")).toBe(false);
      expect(hasModifier("Enter")).toBe(false);
    });
  });

  // ===========================================================================
  // findConflict
  // ===========================================================================
  describe("findConflict", () => {
    const bindings: Record<string, string> = {
      "toggle-sidebar": "Ctrl+B",
      "new-tab": "Ctrl+T",
      "close-tab": "Ctrl+W",
    };

    it("有冲突时应返回冲突的 actionId", () => {
      const result = findConflict(bindings, "some-action", "Ctrl+B");
      expect(result).toBe("toggle-sidebar");
    });

    it("无冲突时应返回 null", () => {
      const result = findConflict(bindings, "some-action", "Ctrl+X");
      expect(result).toBeNull();
    });

    it("自身不算冲突", () => {
      const result = findConflict(bindings, "toggle-sidebar", "Ctrl+B");
      expect(result).toBeNull();
    });

    it("允许终端内缩放与终端外分屏共享 Ctrl+-", () => {
      const sharedBindings = {
        "split-down": "Ctrl+-",
        "terminal-zoom-out": "Ctrl+-",
      };

      expect(findConflict(sharedBindings, "terminal-zoom-out", "Ctrl+-")).toBeNull();
      expect(findConflict(sharedBindings, "split-down", "Ctrl+-")).toBeNull();
    });

    it("终端缩放仍与普通全局动作冲突", () => {
      const sharedBindings = {
        settings: "Ctrl+-",
        "terminal-zoom-out": "Ctrl+-",
      };

      expect(findConflict(sharedBindings, "terminal-zoom-out", "Ctrl+-")).toBe(
        "settings"
      );
    });
  });

  // ===========================================================================
  // Store: registerAction / unregisterAction / setTerminalFocused
  // ===========================================================================
  describe("Store 操作", () => {
    it("registerAction 应注册 action", () => {
      const action = {
        id: "test-action",
        label: "Test",
        handler: vi.fn(),
      };

      useShortcutsStore.getState().registerAction(action);

      const actions = useShortcutsStore.getState().actions;
      expect(actions.has("test-action")).toBe(true);
      expect(actions.get("test-action")?.label).toBe("Test");
    });

    it("unregisterAction 应移除 action", () => {
      const action = {
        id: "test-action",
        label: "Test",
        handler: vi.fn(),
      };
      useShortcutsStore.getState().registerAction(action);

      useShortcutsStore.getState().unregisterAction("test-action");

      expect(useShortcutsStore.getState().actions.has("test-action")).toBe(false);
    });

    it("unregisterAction 对不存在的 id 不应出错", () => {
      useShortcutsStore.getState().unregisterAction("non-exist");
      expect(useShortcutsStore.getState().actions.size).toBe(0);
    });

    it("setTerminalFocused 应更新状态", () => {
      useShortcutsStore.getState().setTerminalFocused(true);
      expect(useShortcutsStore.getState().terminalFocused).toBe(true);

      useShortcutsStore.getState().setTerminalFocused(false);
      expect(useShortcutsStore.getState().terminalFocused).toBe(false);
    });
  });

  // ===========================================================================
  // handleKeydown
  // ===========================================================================
  describe("handleKeydown", () => {
    it("settings 为 null 时应直接返回不处理", () => {
      useSettingsStore.setState({ settings: null });
      const e = createKeyEvent("b", { ctrlKey: true });
      const preventSpy = vi.spyOn(e, "preventDefault");

      handleKeydown(e);

      expect(preventSpy).not.toHaveBeenCalled();
    });

    it("纯修饰键应直接返回（combo 为空）", () => {
      useSettingsStore.setState({
        settings: {
          shortcuts: { bindings: { "toggle-sidebar": "Ctrl+B" } },
        } as never,
      });
      const e = createKeyEvent("Control", { ctrlKey: true });
      const preventSpy = vi.spyOn(e, "preventDefault");

      handleKeydown(e);

      expect(preventSpy).not.toHaveBeenCalled();
    });

    it("匹配的快捷键应调用 handler 并阻止默认行为", () => {
      const handler = vi.fn();
      useShortcutsStore.getState().registerAction({
        id: "toggle-sidebar",
        label: "Toggle Sidebar",
        handler,
      });
      useSettingsStore.setState({
        settings: {
          shortcuts: { bindings: { "toggle-sidebar": "Ctrl+B" } },
        } as never,
      });

      const e = createKeyEvent("b", { ctrlKey: true });
      const preventSpy = vi.spyOn(e, "preventDefault");
      const stopSpy = vi.spyOn(e, "stopPropagation");

      handleKeydown(e);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(preventSpy).toHaveBeenCalled();
      expect(stopSpy).toHaveBeenCalled();
    });

    it("不匹配的快捷键不应调用任何 handler", () => {
      const handler = vi.fn();
      useShortcutsStore.getState().registerAction({
        id: "toggle-sidebar",
        label: "Toggle Sidebar",
        handler,
      });
      useSettingsStore.setState({
        settings: {
          shortcuts: { bindings: { "toggle-sidebar": "Ctrl+B" } },
        } as never,
      });

      const e = createKeyEvent("x", { ctrlKey: true });
      handleKeydown(e);

      expect(handler).not.toHaveBeenCalled();
    });

    it("绑定存在但 action 未注册时不应阻止默认行为", () => {
      // 有绑定但没有注册对应的 action
      useSettingsStore.setState({
        settings: {
          shortcuts: { bindings: { "toggle-sidebar": "Ctrl+B" } },
        } as never,
      });

      const e = createKeyEvent("b", { ctrlKey: true });
      const preventSpy = vi.spyOn(e, "preventDefault");

      handleKeydown(e);

      expect(preventSpy).not.toHaveBeenCalled();
    });

    it("Ctrl+- 根据终端焦点只触发一个上下文动作", () => {
      const splitHandler = vi.fn();
      const zoomHandler = vi.fn();
      useShortcutsStore.getState().registerAction({
        id: "split-down",
        label: "Split Down",
        handler: splitHandler,
      });
      useShortcutsStore.getState().registerAction({
        id: "terminal-zoom-out",
        label: "Zoom Out",
        context: "terminal",
        handler: zoomHandler,
      });
      useSettingsStore.setState({
        settings: {
          shortcuts: {
            bindings: {
              "split-down": "Ctrl+-",
              "terminal-zoom-out": "Ctrl+-",
            },
          },
        } as never,
      });

      useShortcutsStore.getState().setTerminalFocused(true);
      handleKeydown(createKeyEvent("-", { ctrlKey: true }));
      expect(zoomHandler).toHaveBeenCalledTimes(1);
      expect(splitHandler).not.toHaveBeenCalled();

      useShortcutsStore.getState().setTerminalFocused(false);
      handleKeydown(createKeyEvent("-", { ctrlKey: true }));
      expect(splitHandler).toHaveBeenCalledTimes(1);
      expect(zoomHandler).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // shouldTerminalHandleKey
  // ===========================================================================
  describe("shouldTerminalHandleKey", () => {
    it("settings 为 null 时应返回 true（交给终端处理）", () => {
      useSettingsStore.setState({ settings: null });
      const e = createKeyEvent("b", { ctrlKey: true });

      expect(shouldTerminalHandleKey(e)).toBe(true);
    });

    it("纯修饰键应返回 true", () => {
      useSettingsStore.setState({
        settings: {
          shortcuts: { bindings: {} },
        } as never,
      });
      const e = createKeyEvent("Control", { ctrlKey: true });

      expect(shouldTerminalHandleKey(e)).toBe(true);
    });

    it("匹配的快捷键（有修饰键）应返回 false（不交给终端）", () => {
      useShortcutsStore.getState().registerAction({
        id: "toggle-sidebar",
        label: "Toggle Sidebar",
        handler: vi.fn(),
      });
      useSettingsStore.setState({
        settings: {
          shortcuts: { bindings: { "toggle-sidebar": "Ctrl+B" } },
        } as never,
      });

      const e = createKeyEvent("b", { ctrlKey: true });
      expect(shouldTerminalHandleKey(e)).toBe(false);
    });

    it("不匹配的快捷键应返回 true", () => {
      useSettingsStore.setState({
        settings: {
          shortcuts: { bindings: { "toggle-sidebar": "Ctrl+B" } },
        } as never,
      });

      const e = createKeyEvent("x", { ctrlKey: true });
      expect(shouldTerminalHandleKey(e)).toBe(true);
    });

    it("匹配但没有修饰键的快捷键应返回 true（交给终端）", () => {
      useShortcutsStore.getState().registerAction({
        id: "some-action",
        label: "Some Action",
        handler: vi.fn(),
      });
      useSettingsStore.setState({
        settings: {
          shortcuts: { bindings: { "some-action": "A" } },
        } as never,
      });

      const e = createKeyEvent("a");
      // "A" 没有修饰键，hasModifier 返回 false，所以终端应处理
      expect(shouldTerminalHandleKey(e)).toBe(true);
    });

    it("F11 作为快捷键且已注册应返回 false", () => {
      useShortcutsStore.getState().registerAction({
        id: "toggle-fullscreen",
        label: "Toggle Fullscreen",
        handler: vi.fn(),
      });
      useSettingsStore.setState({
        settings: {
          shortcuts: { bindings: { "toggle-fullscreen": "F11" } },
        } as never,
      });

      const e = createKeyEvent("F11");
      // F11 以 F 开头，hasModifier 返回 true
      expect(shouldTerminalHandleKey(e)).toBe(false);
    });

    it("终端聚焦时 Ctrl+K（命令面板）应放行给终端", () => {
      useShortcutsStore.getState().setTerminalFocused(true);
      const handler = vi.fn();
      useShortcutsStore.getState().registerAction({
        id: "command-palette",
        label: "Command Palette",
        handler,
      });
      useSettingsStore.setState({
        settings: {
          shortcuts: { bindings: { "command-palette": "Ctrl+K" } },
        } as never,
      });

      const e = createKeyEvent("k", { ctrlKey: true });
      // 终端聚焦：放行给终端，不触发面板
      expect(shouldTerminalHandleKey(e)).toBe(true);
      handleKeydown(e);
      expect(handler).not.toHaveBeenCalled();

      // 终端失焦：应用接管，打开面板
      useShortcutsStore.getState().setTerminalFocused(false);
      expect(shouldTerminalHandleKey(e)).toBe(false);
      handleKeydown(e);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("终端聚焦时 pane 切换快捷键仍应由应用处理", () => {
      useShortcutsStore.getState().setTerminalFocused(true);
      useShortcutsStore.getState().registerAction({
        id: "focus-pane-left",
        label: "Focus Pane Left",
        handler: vi.fn(),
      });
      useSettingsStore.setState({
        settings: {
          shortcuts: { bindings: { "focus-pane-left": "Alt+Left" } },
        } as never,
      });

      const e = createKeyEvent("ArrowLeft", { altKey: true });
      expect(shouldTerminalHandleKey(e)).toBe(false);
    });

    it("终端聚焦时 Ctrl+- 由终端缩放接管，而非透传给 xterm", () => {
      useShortcutsStore.getState().setTerminalFocused(true);
      useShortcutsStore.getState().registerAction({
        id: "split-down",
        label: "Split Down",
        handler: vi.fn(),
      });
      useShortcutsStore.getState().registerAction({
        id: "terminal-zoom-out",
        label: "Zoom Out",
        context: "terminal",
        handler: vi.fn(),
      });
      useSettingsStore.setState({
        settings: {
          shortcuts: {
            bindings: {
              "split-down": "Ctrl+-",
              "terminal-zoom-out": "Ctrl+-",
            },
          },
        } as never,
      });

      expect(shouldTerminalHandleKey(createKeyEvent("-", { ctrlKey: true }))).toBe(false);
    });
  });

  // ===========================================================================
  // macOS 适配
  //
  // 全部显式传 isMac：jsdom 的 navigator.platform 恒为非 mac，靠环境根本跑不到这条分支，
  // 而"mac 快捷键全都不能用"正出在这里。
  // ===========================================================================
  describe("macOS 适配", () => {
    const MAC = true;

    /** close-tab (Ctrl+W) 是 passthrough 名单成员，拿它验最典型的那条冲突 */
    function setupCloseTab() {
      const handler = vi.fn();
      useShortcutsStore.getState().registerAction({
        id: "close-tab",
        label: "Close Tab",
        handler,
      });
      useSettingsStore.setState({
        settings: { shortcuts: { bindings: { "close-tab": "Ctrl+W" } } } as never,
      });
      return handler;
    }

    it("⌘W 在终端聚焦时应关闭标签——passthrough 名单只该拦 ⌃", () => {
      const handler = setupCloseTab();
      useShortcutsStore.setState({ terminalFocused: true });

      handleKeydown(createKeyEvent("w", { metaKey: true }), MAC);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("⌃W 在终端聚焦时应让给 readline 的 delete-word", () => {
      const handler = setupCloseTab();
      useShortcutsStore.setState({ terminalFocused: true });
      const e = createKeyEvent("w", { ctrlKey: true });
      const preventSpy = vi.spyOn(e, "preventDefault");

      handleKeydown(e, MAC);

      expect(handler).not.toHaveBeenCalled();
      expect(preventSpy).not.toHaveBeenCalled();
    });

    it("⌃W 在终端未聚焦时照常触发绑定", () => {
      const handler = setupCloseTab();
      useShortcutsStore.setState({ terminalFocused: false });

      handleKeydown(createKeyEvent("w", { ctrlKey: true }), MAC);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("shouldTerminalHandleKey：⌘W 归应用、⌃W 归终端", () => {
      setupCloseTab();
      useShortcutsStore.setState({ terminalFocused: true });

      expect(shouldTerminalHandleKey(createKeyEvent("w", { metaKey: true }), MAC)).toBe(false);
      expect(shouldTerminalHandleKey(createKeyEvent("w", { ctrlKey: true }), MAC)).toBe(true);
    });

    it("⌥ 的组字符应回退到物理键位", () => {
      // mac 上 ⌥L 的 key 是 "¬"、⌥1 是 "¡"，按 key 匹配只会得到 "Ctrl+Alt+¬"
      expect(
        parseKeyEvent(createKeyEvent("¬", { metaKey: true, altKey: true, code: "KeyL" })),
      ).toBe("Ctrl+Alt+L");
      expect(parseKeyEvent(createKeyEvent("¡", { altKey: true, code: "Digit1" }))).toBe("Alt+1");
    });

    it("不带 Alt 时仍按键盘标签匹配，不看物理键位", () => {
      // AZERTY 上 code=KeyQ 的键面印着 A，用户按它期望的就是 A
      expect(parseKeyEvent(createKeyEvent("a", { ctrlKey: true, code: "KeyQ" }))).toBe("Ctrl+A");
    });

    it("Alt+方向键不受物理键位回退影响", () => {
      expect(
        parseKeyEvent(createKeyEvent("ArrowLeft", { altKey: true, code: "ArrowLeft" })),
      ).toBe("Alt+Left");
    });

    it("formatKeyCombo 应按 ⌥⇧⌘ 次序排列，⌘ 紧挨键名", () => {
      expect(formatKeyCombo("Ctrl+B", MAC)).toBe("⌘B");
      expect(formatKeyCombo("Ctrl+Shift+T", MAC)).toBe("⇧⌘T");
      expect(formatKeyCombo("Ctrl+Alt+L", MAC)).toBe("⌥⌘L");
      expect(formatKeyCombo("Ctrl+\\", MAC)).toBe("⌘\\");
      expect(formatKeyCombo("F11", MAC)).toBe("F11");
    });

    it("isTerminalPassthroughAction 在 mac 上恒为 false", () => {
      expect(isTerminalPassthroughAction("close-tab", false)).toBe(true);
      expect(isTerminalPassthroughAction("close-tab", MAC)).toBe(false);
    });
  });
});

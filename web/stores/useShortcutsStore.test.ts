import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  useShortcutsStore,
  parseKeyEvent,
  formatKeyCombo,
  hasModifier,
  findConflict,
  handleKeydown,
  shouldTerminalHandleKey,
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
  } = {}
): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key,
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
  });
});

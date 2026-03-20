import { create } from "zustand";
import { useSettingsStore } from "./useSettingsStore";

/**
 * 终端聚焦时放行的快捷键 action ID 集合
 *
 * 这些快捷键与 Claude Code TUI / 终端 readline 功能冲突：
 * - toggle-sidebar (Ctrl+B) → Claude Code: task:background
 * - new-tab        (Ctrl+T) → Claude Code: app:toggleTodos
 * - close-tab      (Ctrl+W) → readline: delete-word
 * - toggle-mini-mode (Ctrl+M) → terminal: Enter (0x0D)
 * - split-right    (Ctrl+\) → terminal: SIGQUIT
 * - split-down     (Ctrl+-) → 部分 TUI 应用使用
 */
const TERMINAL_PASSTHROUGH_ACTIONS = new Set([
  "toggle-sidebar",
  "new-tab",
  "close-tab",
  "toggle-mini-mode",
  "split-right",
  "split-down",
]);

export interface ShortcutAction {
  id: string;
  label: string;
  handler: () => void;
}

interface ShortcutsState {
  actions: Map<string, ShortcutAction>;
  terminalFocused: boolean;
  registerAction: (action: ShortcutAction) => void;
  unregisterAction: (id: string) => void;
  setTerminalFocused: (focused: boolean) => void;
}

/**
 * 将 KeyboardEvent 转换为快捷键字符串
 */
export function parseKeyEvent(e: KeyboardEvent): string {
  const parts: string[] = [];

  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");

  const keyMap: Record<string, string> = {
    Tab: "Tab",
    Escape: "Escape",
    Enter: "Enter",
    Backspace: "Backspace",
    Delete: "Delete",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    " ": "Space",
    ",": ",",
    ".": ".",
    "/": "/",
    "\\": "\\",
    "-": "-",
    "=": "=",
    "[": "[",
    "]": "]",
  };

  const key = e.key;

  if (["Control", "Shift", "Alt", "Meta"].includes(key)) {
    return "";
  }

  if (key.match(/^F\d+$/)) {
    parts.push(key);
  } else if (keyMap[key]) {
    parts.push(keyMap[key]);
  } else if (key.length === 1) {
    parts.push(key.toUpperCase());
  } else {
    parts.push(key);
  }

  return parts.join("+");
}

/**
 * 格式化快捷键显示
 */
export function formatKeyCombo(combo: string): string {
  const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
  if (isMac) {
    return combo
      .replace("Ctrl+", "\u2318")
      .replace("Shift+", "\u21E7")
      .replace("Alt+", "\u2325");
  }
  return combo;
}

/**
 * 检查快捷键是否有修饰键
 */
export function hasModifier(combo: string): boolean {
  return (
    combo.includes("Ctrl+") ||
    combo.includes("Shift+") ||
    combo.includes("Alt+") ||
    combo.startsWith("F")
  );
}

/**
 * 检查快捷键冲突
 */
export function findConflict(
  bindings: Record<string, string>,
  actionId: string,
  newCombo: string
): string | null {
  for (const [id, combo] of Object.entries(bindings)) {
    if (id !== actionId && combo === newCombo) {
      return id;
    }
  }
  return null;
}

/**
 * 全局 keydown 处理器
 */
export function handleKeydown(e: KeyboardEvent) {
  const combo = parseKeyEvent(e);
  if (!combo) return;

  const settings = useSettingsStore.getState().settings;
  if (!settings) return;

  const bindings = settings.shortcuts.bindings;
  const { actions, terminalFocused } = useShortcutsStore.getState();

  for (const [actionId, keyCombo] of Object.entries(bindings)) {
    if (keyCombo === combo) {
      const action = actions.get(actionId);
      if (action) {
        // 终端聚焦时，冲突快捷键放行给终端
        if (terminalFocused && TERMINAL_PASSTHROUGH_ACTIONS.has(actionId)) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        action.handler();
        return;
      }
    }
  }
}

/**
 * xterm 自定义按键处理器
 */
export function shouldTerminalHandleKey(e: KeyboardEvent): boolean {
  const combo = parseKeyEvent(e);
  if (!combo) return true;

  const settings = useSettingsStore.getState().settings;
  if (!settings) return true;

  const bindings = settings.shortcuts.bindings;
  const { actions, terminalFocused } = useShortcutsStore.getState();

  for (const [actionId, keyCombo] of Object.entries(bindings)) {
    if (keyCombo === combo && actions.has(actionId) && hasModifier(combo)) {
      // 终端聚焦时，冲突快捷键放行给终端处理
      if (terminalFocused && TERMINAL_PASSTHROUGH_ACTIONS.has(actionId)) {
        return true;
      }
      return false;
    }
  }

  return true;
}

export const useShortcutsStore = create<ShortcutsState>((set) => ({
  actions: new Map(),
  terminalFocused: false,

  registerAction: (action) => {
    set((state) => {
      const newActions = new Map(state.actions);
      newActions.set(action.id, action);
      return { actions: newActions };
    });
  },

  unregisterAction: (id) => {
    set((state) => {
      const newActions = new Map(state.actions);
      newActions.delete(id);
      return { actions: newActions };
    });
  },

  setTerminalFocused: (focused) => set({ terminalFocused: focused }),
}));

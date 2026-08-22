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
 * - command-palette (Ctrl+K) → readline: kill-line / Claude Code 常用
 *
 * 仅对「Ctrl 即应用修饰键」的平台成立。mac 上应用键是 ⌘、终端键是 ⌃，⌘W 对 readline
 * 毫无意义，照样放行等于白白吞掉最常用的 7 个快捷键——而主界面几乎总是终端聚焦，
 * 表现就是"mac 快捷键全都不能用"。mac 的让行改由 handleKeydown 按真实 ⌃ 键判断。
 */
const TERMINAL_PASSTHROUGH_ACTIONS = new Set([
  "toggle-sidebar",
  "new-tab",
  "close-tab",
  "toggle-mini-mode",
  "split-right",
  "split-down",
  "command-palette",
]);

const TERMINAL_ONLY_ACTIONS = new Set([
  "terminal-zoom-in",
  "terminal-zoom-out",
  "terminal-zoom-reset",
]);

function detectMac(): boolean {
  return typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");
}

/**
 * 该 action 的快捷键在终端聚焦时是否会被放行给终端。
 *
 * 供 UI（如功能提示）派生"什么时候按了没反应"的说明，避免各处手写清单副本。
 *
 * mac 上恒为 false：那边应用键是 ⌘、终端键是 ⌃，物理上就不抢同一个组合（见
 * TERMINAL_PASSTHROUGH_ACTIONS 与 handleKeydown 的说明），再提示"终端里按了没反应"是误导。
 */
export function isTerminalPassthroughAction(actionId: string, isMac: boolean = detectMac()): boolean {
  if (isMac) return false;
  return TERMINAL_PASSTHROUGH_ACTIONS.has(actionId);
}

export interface ShortcutAction {
  id: string;
  label: string;
  handler: () => void;
  context?: "global" | "terminal";
}

interface ShortcutsState {
  actions: Map<string, ShortcutAction>;
  terminalFocused: boolean;
  registerAction: (action: ShortcutAction) => void;
  unregisterAction: (id: string) => void;
  setTerminalFocused: (focused: boolean) => void;
}

/**
 * 取物理键位上的字母/数字，拿不到返回 null。
 *
 * mac 的 Option 是组字键：⌥L 的 e.key 是 "¬"、⌥1 是 "¡"，拿它去比对绑定表永远匹配不上，
 * toggle-layouts(Ctrl+Alt+L)、voice-input(Ctrl+Alt+M)、switch-layout-1..9(Alt+N) 因此在
 * mac 上集体失效。只在 Alt 按下时启用：其余情况仍按键盘标签匹配，不影响 AZERTY/Dvorak
 * 用户。方向键这类 code 与 key 同名的走 null 回原路径。
 */
function physicalAlphanumericKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return null;
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

  if (e.altKey) {
    const physical = physicalAlphanumericKey(e.code);
    if (physical) {
      parts.push(physical);
      return parts.join("+");
    }
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
export function formatKeyCombo(combo: string, isMac: boolean = detectMac()): string {
  if (!isMac) return combo;
  const parts = combo.split("+");
  // "Ctrl+\\" \u8FD9\u7C7B\u672B\u6BB5\u672C\u8EAB\u662F "\\"\uFF0Csplit \u4E0D\u4F1A\u51FA\u7A7A\u6BB5\uFF1B\u515C\u5E95\u53EA\u4E3A combo \u672B\u5C3E\u6070\u597D\u662F "+" \u7684\u7578\u5F62\u503C\u3002
  const key = parts.pop() || "+";
  const has = (name: string) => parts.includes(name);
  // mac \u4FEE\u9970\u952E\u7684\u663E\u793A\u6B21\u5E8F\u56FA\u5B9A \u2303\u2325\u21E7\u2318\uFF0C\u4E0E\u952E\u76D8\u4E0A\u4ECE\u5DE6\u5230\u53F3\u4E00\u81F4\u3002\u7ED1\u5B9A\u8868\u91CC\u7684 "Ctrl" \u5728 mac \u4E0A
  // \u4EE3\u8868 \u2318\uFF08handleKeydown \u628A metaKey \u4E5F\u5F52\u4E00\u5316\u6210\u5B83\uFF09\uFF0C\u6240\u4EE5\u6392\u6700\u53F3\u3001\u7D27\u6328\u952E\u540D\u3002
  const symbols = `${has("Alt") ? "\u2325" : ""}${has("Shift") ? "\u21E7" : ""}${has("Ctrl") ? "\u2318" : ""}`;
  return `${symbols}${key}`;
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
    if (id !== actionId && combo === newCombo && actionContextsOverlap(id, actionId)) {
      return id;
    }
  }
  return null;
}

function getActionContext(actionId: string): "global" | "terminal" {
  return (
    useShortcutsStore.getState().actions.get(actionId)?.context ??
    (TERMINAL_ONLY_ACTIONS.has(actionId) ? "terminal" : "global")
  );
}

function isActionActive(
  actionId: string,
  terminalFocused: boolean,
  isMac: boolean = detectMac(),
): boolean {
  if (getActionContext(actionId) === "terminal") {
    return terminalFocused;
  }
  // mac 走 shouldYieldToTerminal 按真实 ⌃ 键让行，这里不能再按 combo 字符串减一遍：
  // ⌘W 和 ⌃W 归一化后都是 "Ctrl+W"，减了就把 ⌘W 一起吞掉。
  if (isMac) return true;
  return !(terminalFocused && TERMINAL_PASSTHROUGH_ACTIONS.has(actionId));
}

/**
 * mac 上终端聚焦时，真 ⌃ 组合整个让给终端。
 *
 * ⌃C/⌃D/⌃A/⌃E/⌃K 都是 readline 命令，抢一个终端就残废；而应用快捷键在 mac 上按 ⌘ 触发，
 * 两者不重叠。判断放在事件层而不是 combo 字符串层——parseKeyEvent 把 ⌃ 和 ⌘ 都写成 "Ctrl"，
 * 到字符串阶段已经分不出用户按的是哪个。
 *
 * 只在终端聚焦时让行：⌃Tab 切标签这类在其他区域仍按绑定表生效。
 */
function shouldYieldToTerminal(e: KeyboardEvent, terminalFocused: boolean, isMac: boolean): boolean {
  return isMac && terminalFocused && e.ctrlKey && !e.metaKey;
}

function actionContextsOverlap(firstActionId: string, secondActionId: string): boolean {
  const firstTerminalOnly = getActionContext(firstActionId) === "terminal";
  const secondTerminalOnly = getActionContext(secondActionId) === "terminal";

  if (firstTerminalOnly && TERMINAL_PASSTHROUGH_ACTIONS.has(secondActionId)) {
    return false;
  }
  if (secondTerminalOnly && TERMINAL_PASSTHROUGH_ACTIONS.has(firstActionId)) {
    return false;
  }
  return true;
}

/**
 * 全局 keydown 处理器
 */
export function handleKeydown(e: KeyboardEvent, isMac: boolean = detectMac()) {
  const combo = parseKeyEvent(e);
  if (!combo) return;

  const settings = useSettingsStore.getState().settings;
  if (!settings) return;

  const bindings = settings.shortcuts.bindings;
  const { actions, terminalFocused } = useShortcutsStore.getState();
  if (shouldYieldToTerminal(e, terminalFocused, isMac)) return;

  for (const [actionId, keyCombo] of Object.entries(bindings)) {
    const action = actions.get(actionId);
    if (keyCombo !== combo || !action || !isActionActive(actionId, terminalFocused, isMac)) {
      continue;
    }
    e.preventDefault();
    e.stopPropagation();
    action.handler();
    return;
  }
}

/**
 * xterm 自定义按键处理器
 */
export function shouldTerminalHandleKey(e: KeyboardEvent, isMac: boolean = detectMac()): boolean {
  const combo = parseKeyEvent(e);
  if (!combo) return true;

  const settings = useSettingsStore.getState().settings;
  if (!settings) return true;

  const bindings = settings.shortcuts.bindings;
  const { actions, terminalFocused } = useShortcutsStore.getState();
  if (shouldYieldToTerminal(e, terminalFocused, isMac)) return true;

  for (const [actionId, keyCombo] of Object.entries(bindings)) {
    if (
      keyCombo === combo &&
      actions.has(actionId) &&
      hasModifier(combo) &&
      isActionActive(actionId, terminalFocused, isMac)
    ) {
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

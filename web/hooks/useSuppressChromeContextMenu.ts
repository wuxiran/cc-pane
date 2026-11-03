// 应用外壳的 WebView 原生右键菜单拦截（docs/46 §5.1 原生手感）。
//
// 标题栏 / 活动栏 / 状态栏 / 侧栏空白处右键会弹出 WebKit（dev 下 Reload/Inspect Element）
// 或 WebView2 自带菜单，桌面应用不该有。只在以下场景放行：
// - 终端宿主（`.cc-terminal-host` / `.xterm`）：交给 TerminalContextMenu，见 terminalViewHelpers.ts；
// - 可编辑元素（input / textarea / contenteditable）：保留系统的剪切/拷贝/粘贴/拼写菜单；
// - `[data-native-context-menu]` 祖先内：内容区的显式逃生口；
// - 右键落在当前选中的文字上：系统的「拷贝 / 查询 / 搜索」菜单是原生正文的标配，内容区
//   （消息、Markdown 预览、diff）不用逐个打标记就能保住；chrome 文字是 user-select:none，
//   选不中，所以这条不会把 chrome 区域重新放开；
// - 已被前端自己处理的右键（`event.defaultPrevented`，Radix ContextMenu trigger 会调 preventDefault）。
//
// 监听挂在 window 的**冒泡阶段**：React 根容器的委托监听先跑完（Radix 已有机会 preventDefault），
// 这里最后判断。不能用 capture，否则会抢在 Radix 前面。挂在 window 而不是外壳根 div，
// 是为了覆盖 portal 出去的弹层（Dialog/Popover 不在外壳 DOM 子树里）。
import { useEffect } from "react";

const NATIVE_MENU_ALLOWED_SELECTOR = [
  ".cc-terminal-host",
  ".xterm",
  "input",
  "textarea",
  '[contenteditable]:not([contenteditable="false"])',
  "[data-native-context-menu]",
].join(", ");

function targetElement(target: EventTarget | null): Element | null {
  if (!target || typeof (target as Node).nodeType !== "number") return null;
  const node = target as Node;
  if (node.nodeType === Node.ELEMENT_NODE) return node as Element;
  return node.parentElement;
}

/** 目标是否落在当前非空的文字选区内（部分相交即算）。 */
function targetInsideSelection(element: Element): boolean {
  if (typeof window.getSelection !== "function") return false;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  for (let i = 0; i < selection.rangeCount; i += 1) {
    const range = selection.getRangeAt(i);
    if (!range.collapsed && range.intersectsNode(element)) return true;
  }
  return false;
}

/** 该次右键是否应保留 WebView 原生菜单（或交给前端已有的处理）。 */
export function shouldAllowNativeContextMenu(event: Event): boolean {
  if (event.defaultPrevented) return true;
  const element = targetElement(event.target);
  if (!element) return false;
  if (element.closest(NATIVE_MENU_ALLOWED_SELECTOR) !== null) return true;
  return targetInsideSelection(element);
}

export function handleChromeContextMenu(event: Event): void {
  if (shouldAllowNativeContextMenu(event)) return;
  event.preventDefault();
}

export function useSuppressChromeContextMenu(): void {
  useEffect(() => {
    window.addEventListener("contextmenu", handleChromeContextMenu);
    return () => window.removeEventListener("contextmenu", handleChromeContextMenu);
  }, []);
}

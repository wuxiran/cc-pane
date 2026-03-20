/**
 * 全局拖拽状态标志（模块级同步变量，非 Zustand）
 *
 * 供 SplitView 设置、TerminalView 读取。
 * 零 React 开销：不触发任何组件 re-render。
 */

let _dragging = false;

export function setDragging(v: boolean): void {
  _dragging = v;
}

export function isDragging(): boolean {
  return _dragging;
}

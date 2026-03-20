/**
 * 面板树类型定义
 * 用于表示动态分屏布局结构
 */

import type { Tab } from "./terminal";

/** 面板节点类型：通用面板或分割容器 */
export type PaneNode = Panel | SplitPane;

/** 通用面板 - 包含多个标签 */
export interface Panel {
  type: "panel";
  id: string;
  tabs: Tab[];
  activeTabId: string;
}

/** 分割容器 - 包含多个子面板 */
export interface SplitPane {
  type: "split";
  id: string;
  direction: "horizontal" | "vertical"; // horizontal: 左右分割, vertical: 上下分割
  children: PaneNode[];
  sizes: number[]; // 各子面板占比百分比
}

/** 面板操作类型 */
export type SplitDirection = "right" | "down";

/** 面板上下文菜单项 */
export interface PaneContextAction {
  label: string;
  action: () => void;
  icon?: string;
  disabled?: boolean;
  divider?: boolean;
}

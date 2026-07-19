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

/** 一套可切换的整屏分屏布局 */
export interface LayoutEntry {
  id: string;
  name: string;
  kind?: "normal" | "starred";
  rootPane: PaneNode;
  activePaneId: string;
  /** 手动绑定的工作空间名（全链路以 name 为键，无 id）；未绑定时按布局内标签推导 */
  workspaceName?: string;
  /** 最近激活时间戳，同工作空间命中多个布局时取最近使用者 */
  lastActiveAt?: number;
}

/** 面板操作类型 */
export type SplitDirection = "right" | "down";

/** 分屏方向，`auto` 表示按父容器方向取反（螺旋落位） */
export type AutoSplitDirection = SplitDirection | "auto";

/** 分屏布局预设：一键把当前布局的分屏树重排成固定结构 */
export type LayoutPresetId =
  | "single"
  | "two-col"
  | "three-col"
  | "two-row"
  | "grid-2x2"
  | "main-side";

/** 面板上下文菜单项 */
export interface PaneContextAction {
  label: string;
  action: () => void;
  icon?: string;
  disabled?: boolean;
  divider?: boolean;
}

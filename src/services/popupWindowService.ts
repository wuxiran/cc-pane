/**
 * 弹出窗口服务 - 管理终端标签弹出为独立系统窗口
 */

import { invoke } from "@tauri-apps/api/core";

export interface PopupTabData {
  tabId: string;
  paneId: string;
  sessionId: string;
  projectPath: string;
  title: string;
  workspaceName?: string;
  providerId?: string;
  workspacePath?: string;
}

/** 已弹出的 tabId -> window label 映射 */
const poppedTabs = new Map<string, string>();

/** 弹出标签为独立窗口 */
export async function popOutTab(data: PopupTabData): Promise<void> {
  const label = `popup-${data.tabId}`;
  const tabDataJson = JSON.stringify(data);
  await invoke("create_popup_terminal_window", {
    tabData: tabDataJson,
    label,
  });
  poppedTabs.set(data.tabId, label);
}

/** 检查标签是否已弹出 */
export function isTabPoppedOut(tabId: string): boolean {
  return poppedTabs.has(tabId);
}

/** 标记标签已回收 */
export function markTabReclaimed(tabId: string): void {
  poppedTabs.delete(tabId);
}

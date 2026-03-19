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

/** 弹出窗口启动后从 Rust PopupDataStore 获取 tabData（one-shot，带重试） */
export async function getPopupTabData(): Promise<PopupTabData | null> {
  // 重试机制：WebView JS 可能在 Rust 写入数据之前就执行
  for (let i = 0; i < 5; i++) {
    const raw = await invoke<string | null>("get_popup_tab_data");
    if (raw) {
      try {
        return JSON.parse(raw) as PopupTabData;
      } catch {
        console.error("[popupWindowService] Failed to parse tab data:", raw);
        return null;
      }
    }
    if (i < 4) await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

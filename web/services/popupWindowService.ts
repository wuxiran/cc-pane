/**
 * 弹出窗口服务 - 管理终端标签弹出为独立系统窗口
 */

import type { CliTool, LaunchProviderSelection } from "@/types";
import { invokeIfTauri, isTauriRuntime } from "./runtime";

export interface PopupTabData {
  tabId: string;
  paneId: string;
  /** null = 前端首次挂载时自建会话（F1 快捷终端走此路径） */
  sessionId: string | null;
  projectPath: string;
  title: string;
  /** "quick" = F1 全局快捷终端（Quake 式下拉）；缺省 = 普通 tab 弹出窗口 */
  mode?: "quick";
  workspaceName?: string;
  providerId?: string;
  modelId?: string;
  providerSelection?: LaunchProviderSelection;
  launchProfileId?: string;
  workspacePath?: string;
  /** 会话里跑的 CLI：决定渲染管线（claude/codex 的输出留在主缓冲区），缺了历史会显示不出来 */
  cliTool?: CliTool;
  launchClaude?: boolean;
}

/** 已弹出的 tabId -> window label 映射 */
const poppedTabs = new Map<string, string>();

/** 弹出标签为独立窗口 */
export async function popOutTab(data: PopupTabData): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error("Pop-out windows are only available in the desktop app");
  }
  const label = `popup-${data.tabId}`;
  const tabDataJson = JSON.stringify(data);
  await invokeIfTauri("create_popup_terminal_window", {
    tabData: tabDataJson,
    label,
  });
  poppedTabs.set(data.tabId, label);
}

/** 检查标签是否已弹出 */
export function isTabPoppedOut(tabId: string): boolean {
  return poppedTabs.has(tabId);
}

/**
 * 把已弹出的 tab 所在的独立窗口唤到前台（docs/105 F7.3）。
 *
 * 返回 true 表示窗口确实被聚焦；false 表示窗口已不存在（关闭事件丢失、用户直接
 * 点了系统标题栏的关闭按钮等），调用方据此自愈。Web 运行时没有多窗口，恒 false。
 */
export async function focusPoppedOutTab(tabId: string): Promise<boolean> {
  const label = poppedTabs.get(tabId);
  if (!label) return false;
  if (!isTauriRuntime()) return false;
  try {
    const focused = await invokeIfTauri<boolean>("focus_popup_terminal_window", { label });
    return focused === true;
  } catch (err) {
    // 聚焦失败不应该让通知点击整个炸掉：交回调用方走主窗口内定位的回退路径。
    console.error("[popupWindowService] Failed to focus popup window:", err);
    return false;
  }
}

/** 标记标签已回收 */
export function markTabReclaimed(tabId: string): void {
  poppedTabs.delete(tabId);
}

/** 获取所有已弹出标签的 tabId -> windowLabel 映射副本 */
export function getPoppedTabs(): Map<string, string> {
  return new Map(poppedTabs);
}

/** 弹出窗口启动后从 Rust PopupDataStore 获取 tabData（one-shot，带重试） */
export async function getPopupTabData(): Promise<PopupTabData | null> {
  if (!isTauriRuntime()) return null;
  // 重试机制：WebView JS 可能在 Rust 写入数据之前就执行
  for (let i = 0; i < 5; i++) {
    const raw = await invokeIfTauri<string | null>("get_popup_tab_data");
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

/**
 * 布局懒挂载策略（issue #43）——纯逻辑，无 React / store 依赖。
 *
 * 两条规则：
 * 1. 本次会话没访问过的布局不挂载（首次切入才挂）。
 * 2. 挂过但长时间没访问的布局卸载视图（状态仍在 panes store，PTY 仍在 daemon），
 *    下次切回按首次访问同路重建：终端走 attach + 后端 snapshot 重放，与停泊唤醒同路。
 *
 * 卸载不是对所有布局都安全：下列内容的状态只活在组件实例或原生资源里，卸载即丢，
 * 所以含它们的布局只做「首次访问才挂」，不做「久未访问卸载」。
 */
import { collectPanels, collectTerminalLeaves } from "@/lib/paneTree";
import type { LayoutEntry, Tab } from "@/types";

/** 卸载会丢状态的标签类型：浏览器/dsh = 原生 webview 随卸载关闭；编辑器 = 未保存文本在组件本地；agent-chat = 滚动/折叠/选择等会话 UI。 */
const UNMOUNT_UNSAFE_CONTENT: ReadonlySet<Tab["contentType"]> = new Set([
  "browser",
  "dsh",
  "editor",
  "agent-chat",
]);

export type LayoutUnmountBlocker = "unsafe-content" | "dirty-tab" | "ssh-terminal";

function tabBlocker(tab: Tab): LayoutUnmountBlocker | null {
  if (UNMOUNT_UNSAFE_CONTENT.has(tab.contentType)) return "unsafe-content";
  if (tab.dirty) return "dirty-tab";
  // SSH 断线只有挂载中的视图才会写回 disconnected（Panel.handleSessionExited），卸载后会漏标。
  if (tab.ssh) return "ssh-terminal";
  if (collectTerminalLeaves(tab.terminalRootPane).some((leaf) => leaf.ssh)) return "ssh-terminal";
  return null;
}

/** 返回阻止卸载该布局视图的原因；null = 可安全卸载。 */
export function layoutUnmountBlocker(layout: LayoutEntry): LayoutUnmountBlocker | null {
  for (const panel of collectPanels(layout.rootPane)) {
    for (const tab of panel.tabs) {
      const blocker = tabBlocker(tab);
      if (blocker) return blocker;
    }
  }
  return null;
}

/** 布局里是否有 agent-chat 标签（未挂载时也要保证事件监听已就位）。 */
export function layoutsHaveAgentChat(layouts: readonly LayoutEntry[]): boolean {
  return layouts.some((layout) =>
    collectPanels(layout.rootPane).some((panel) =>
      panel.tabs.some((tab) => tab.contentType === "agent-chat"),
    ),
  );
}

export interface LayoutEvictionInput {
  layouts: readonly LayoutEntry[];
  mounted: ReadonlySet<string>;
  currentLayoutId: string;
  /** 布局最近一次从当前切走的时刻；缺记录 = 尚未切走过（不计时）。 */
  hiddenSince: ReadonlyMap<string, number>;
  now: number;
  delayMs: number;
}

export interface LayoutEvictionPlan {
  /** 已到期且可卸载的布局 id。 */
  expired: string[];
  /** 下一个到期时刻（用于排定时器）；null = 无需计时。 */
  nextDeadline: number | null;
}

/** 计算本轮应卸载的布局与下一次检查时刻。当前布局永不卸载。 */
export function planLayoutEviction({
  layouts,
  mounted,
  currentLayoutId,
  hiddenSince,
  now,
  delayMs,
}: LayoutEvictionInput): LayoutEvictionPlan {
  const expired: string[] = [];
  let nextDeadline: number | null = null;
  for (const layout of layouts) {
    if (layout.id === currentLayoutId || !mounted.has(layout.id)) continue;
    const since = hiddenSince.get(layout.id);
    if (since === undefined || layoutUnmountBlocker(layout)) continue;
    const deadline = since + delayMs;
    if (deadline <= now) {
      expired.push(layout.id);
    } else if (nextDeadline === null || deadline < nextDeadline) {
      nextDeadline = deadline;
    }
  }
  return { expired, nextDeadline };
}

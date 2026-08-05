// closedTabs 上限裁剪（docs/68 §2.3 T1-c）。
// push 点（closeTab / closePane）正随 0.12.0 批1 迁往 paneRemovalActions.ts，
// 本函数先独立成工具：reopenClosedTab 侧已接（惰性裁剪），push 点由 leader
// 在 B1-05 收口时接入（push 后调一次即得严格上限）。
import type { ClosedTabSnapshot } from "./panesStoreTypes";

/** 单次运行内可恢复的已关闭标签上限；超出的最旧快照被丢弃。 */
export const CLOSED_TABS_LIMIT = 20;

/**
 * 原地裁剪到上限，保留数组尾部（最近关闭的）。
 * 接受 Immer draft 或普通数组；返回同一引用便于链式使用。
 */
export function trimClosedTabs(
  list: ClosedTabSnapshot[],
  limit: number = CLOSED_TABS_LIMIT,
): ClosedTabSnapshot[] {
  if (list.length > limit) {
    list.splice(0, list.length - limit);
  }
  return list;
}

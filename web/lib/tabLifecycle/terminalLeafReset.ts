// 终端 leaf 的「重新启动前重置清单」（docs/78 批4）。
//
// 同一份清单有两个消费方：分屏克隆（usePanesStore.cloneTerminalLeaf）与关闭撤销
// （closedTabsUndo 的快照/回放）。清单漏一项的后果都是**静默的**：漏 sessionId
// 会让新 leaf 指向一个已死的 PTY；漏 savedSessionId 会让它以为自己正在恢复；
// 漏 initialPrompt 会在恢复出来的会话里重放一遍首启 prompt。
//
// 所以清单只此一份，两处共用。
import { generateId } from "@/lib/paneTree";
import { inferCliTool, resolveRestoreMode } from "@/lib/terminalRestoreMode";
import type { LaunchExtras, TerminalPaneLeaf, TerminalPaneNode } from "@/types";

/** 去掉 launchExtras 中的 initialPrompt（防重放）；无其余字段时整体归 undefined。 */
export function stripInitialPrompt(extras: LaunchExtras | undefined): LaunchExtras | undefined {
  if (!extras) return undefined;
  if (extras.initialPrompt === undefined) return extras;
  const { initialPrompt: _initialPrompt, ...rest } = extras;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/**
 * 重置一个 leaf 使其可重新启动：新 id、新 launchId（docs/69：launch 身份每次
 * 新生成）、清空全部运行时状态、剥掉 initialPrompt。启动身份字段（resumeId /
 * provider / cliTool / ssh / wsl 等）原样保留。
 */
export function resetTerminalLeafForRelaunch(source: TerminalPaneLeaf): TerminalPaneLeaf {
  return {
    ...source,
    id: generateId("terminal-pane"),
    launchId: generateId("launch"),
    restoreMode: resolveRestoreMode({
      cliTool: inferCliTool(source.cliTool, source.launchClaude, source.resumeId),
      resumeId: source.resumeId,
    }),
    sessionId: null,
    disconnected: false,
    restoring: false,
    savedSessionId: undefined,
    restoreBlockedReason: undefined,
    leaseReadOnly: false,
    launchError: undefined,
    launchAttempt: 0,
    launchExtras: stripInitialPrompt(source.launchExtras),
  };
}

/**
 * 整棵终端分屏树的重置（结构与 sizes 原样保留，每个 leaf 过重置清单，
 * split 节点也换新 id——同一棵树可能被撤销栈重开多次，id 撞车会让
 * findTerminalPane 命中错误的格子）。
 */
export function resetTerminalTreeForRelaunch(node: TerminalPaneNode): TerminalPaneNode {
  if (node.type === "leaf") return resetTerminalLeafForRelaunch(node);
  return {
    ...node,
    id: generateId("terminal-split"),
    children: node.children.map(resetTerminalTreeForRelaunch),
    sizes: [...node.sizes],
  };
}

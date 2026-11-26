// 「重启并续接」：把运行中的终端 leaf 原地（原面板、原标签位置）关掉重开，
// 带 resumeId 续上原对话。典型场景：用 rec 切换了 Claude 账号，已运行的会话
// 仍挂在旧账号的 CLAUDE_CONFIG_DIR 上，必须重新拉起才会落到新账号。
//
// 与冷恢复（terminalColdRestoreActions.ts）同一套路：先从 leaf 摘掉 sessionId，
// 再 kill（否则 session-killed 事件会经 closeTabBySessionId 把整个标签关掉），
// kill 成功后递增 launchAttempt，TerminalView 以新 key 重挂载并重新 createSession。
import {
  collectPanels,
  collectTerminalLeaves,
  findTerminalPane,
  generateId,
} from "@/lib/paneTree";
import { stripInitialPrompt } from "@/lib/tabLifecycle/terminalLeafReset";
import { inferCliTool, resolveRestoreMode } from "@/lib/terminalRestoreMode";
import type { Tab } from "@/types";
import { eachLayoutTree } from "./paneLayoutHelpers";
import type {
  DraftTabAcrossLayoutsLocation,
  PanesDraft,
  PanesState,
  TerminalRelaunchTarget,
} from "./panesStoreTypes";

type RelaunchActions = Pick<
  PanesState,
  "collectClaudeRelaunchTargets" | "beginTerminalRelaunch" | "finishTerminalRelaunch"
>;

interface RelaunchActionDependencies {
  get: () => PanesState;
  set: (recipe: (state: PanesDraft) => void) => void;
  findTab: (state: PanesDraft, tabId: string) => DraftTabAcrossLayoutsLocation | null;
  syncTab: (tab: Tab) => void;
  notifyLayoutChanged: (reason: string) => void;
}

export function createTerminalRelaunchActions(
  dependencies: RelaunchActionDependencies,
): RelaunchActions {
  const { get, set, findTab, syncTab, notifyLayoutChanged } = dependencies;
  return {
    collectClaudeRelaunchTargets: (options) => {
      const targets: TerminalRelaunchTarget[] = [];
      const seenSessions = new Set<string>();
      // eachLayoutTree 跳过星标布局：星标只是镜像，同一会话不重复处理。
      eachLayoutTree(get(), (layout, tree) => {
        for (const panel of collectPanels(tree)) {
          for (const tab of panel.tabs) {
            if (tab.contentType !== "terminal" || !tab.terminalRootPane) continue;
            if (options?.tabId && tab.id !== options.tabId) continue;
            for (const leaf of collectTerminalLeaves(tab.terminalRootPane)) {
              if (!leaf.sessionId || seenSessions.has(leaf.sessionId)) continue;
              const cliTool = inferCliTool(
                leaf.cliTool ?? tab.cliTool,
                leaf.launchClaude,
                tab.launchClaude,
              );
              if (cliTool !== "claude") continue;
              // 只处理本机会话：rec 账号目录只在本机，SSH/WSL 不受影响。
              if (leaf.ssh || leaf.wsl || tab.ssh || tab.wsl) continue;
              seenSessions.add(leaf.sessionId);
              targets.push({
                layoutId: layout.id,
                tabId: tab.id,
                terminalPaneId: leaf.id,
                sessionId: leaf.sessionId,
                resumeId: leaf.resumeId ?? tab.resumeId,
                title: tab.title,
              });
            }
          }
        }
      });
      return targets;
    },

    beginTerminalRelaunch: (tabId, terminalPaneId, expectedSessionId) => {
      let previousSessionId: string | null = null;
      set((state) => {
        const tab = findTab(state, tabId)?.tab;
        if (!tab || tab.contentType !== "terminal" || !tab.terminalRootPane) return;
        const leaf = findTerminalPane(tab.terminalRootPane, terminalPaneId);
        if (leaf?.type !== "leaf" || !leaf.sessionId) return;
        if (expectedSessionId && leaf.sessionId !== expectedSessionId) return;
        previousSessionId = leaf.sessionId;
        // 先摘掉 sessionId：kill 引发的 session-killed 事件找不到该会话，就不会关标签。
        leaf.sessionId = null;
        leaf.restoring = true;
        syncTab(tab);
      });
      if (previousSessionId) notifyLayoutChanged("relaunch.begin");
      return previousSessionId;
    },

    finishTerminalRelaunch: (tabId, terminalPaneId, previousSessionId, succeeded) => {
      set((state) => {
        const tab = findTab(state, tabId)?.tab;
        if (!tab || tab.contentType !== "terminal" || !tab.terminalRootPane) return;
        const leaf = findTerminalPane(tab.terminalRootPane, terminalPaneId);
        if (leaf?.type !== "leaf" || leaf.sessionId) return;
        if (!succeeded) {
          // kill 失败：旧进程还活着，把 sessionId 接回去，保持原状。
          leaf.sessionId = previousSessionId;
          leaf.restoring = false;
          syncTab(tab);
          return;
        }
        // 与 resetTerminalLeafForRelaunch 同一份清单，但保留 leaf.id（原位重开）。
        leaf.launchId = generateId("launch");
        leaf.disconnected = false;
        leaf.savedSessionId = undefined;
        leaf.restoreBlockedReason = undefined;
        leaf.leaseReadOnly = false;
        leaf.launchError = undefined;
        leaf.launchExtras = stripInitialPrompt(leaf.launchExtras);
        leaf.restoring = true;
        leaf.launchAttempt = (leaf.launchAttempt ?? 0) + 1;
        leaf.restoreMode = resolveRestoreMode({
          cliTool: inferCliTool(leaf.cliTool ?? tab.cliTool, leaf.launchClaude, tab.launchClaude),
          resumeId: leaf.resumeId ?? tab.resumeId,
          launchFailure: leaf.launchFailure,
        });
        syncTab(tab);
      });
      notifyLayoutChanged(succeeded ? "relaunch.finish" : "relaunch.rollback");
    },
  };
}

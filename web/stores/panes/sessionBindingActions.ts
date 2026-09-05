// 会话绑定/恢复 actions：resumeId 绑定、断连重连、daemon 会话收养与锚点接管、
// 引用会话收集。从 usePanesStore.ts 拆出（纯代码移动，逻辑不变）；
// 在 usePanesStore 里 spread 挂载。
import { collectPanels, findPane, generateId, notifyTerminalLayoutChanged, syncTabTerminalState } from "@/lib/paneTree";
import { collectTerminalLeaves, findTerminalPane } from "@/lib/paneSessions";
import { terminalService, ensureListeners } from "@/services/terminalService";
import { waitForTerminalRestoreBarrierWithDeadline } from "@/services/terminalRestoreBarrier";
import { projectPathsEquivalent } from "@/utils/projectIdentity";
import type { PaneNode, Tab } from "@/types";
import { activateFirstNormalLayout, eachLayoutTree } from "../paneLayoutHelpers";
import { useTerminalStatusStore } from "../useTerminalStatusStore";
import type { PanesState } from "../panesStoreTypes";
import { createTab } from "./createTab";
import { findTabAcrossLayouts } from "./crossLayoutSearch";
import { eachLayout, someLayout } from "./layoutTraversal";
import type { PanesStoreAccess } from "./storeAccess";

export type SessionBindingActions = Pick<
  PanesState,
  | "updateTabAgentResumeId"
  | "updateTabClaudeSession"
  | "setTabResumeBinding"
  | "reconnectTab"
  | "restoreLiveDaemonSessions"
  | "getRestorableTabs"
  | "collectReferencedSessionIds"
  | "setBackgroundRestoreSession"
  | "setSessionLeaseReadOnly"
  | "canCreateTerminalSession"
  | "attachSessionToAnchor"
  | "adoptSession"
>;

export function createSessionBindingActions({ set, get }: PanesStoreAccess): SessionBindingActions {
  return {
    updateTabAgentResumeId: (ptySessionId, agentResumeId, resumeIdSource) => {
      let found = false;
      let changed = false;
      set((state) => {
        const update = (node: PaneNode): boolean => {
          if (node.type === "panel") {
            for (const tab of node.tabs) {
              if (tab.contentType === "terminal" && tab.terminalRootPane) {
                for (const leaf of collectTerminalLeaves(tab.terminalRootPane)) {
                  if (leaf.sessionId === ptySessionId) {
                    if (
                      leaf.resumeId !== agentResumeId
                      || (resumeIdSource && leaf.resumeIdSource !== resumeIdSource)
                    ) {
                      changed = true;
                    }
                    leaf.resumeId = agentResumeId;
                    if (resumeIdSource) leaf.resumeIdSource = resumeIdSource;
                    syncTabTerminalState(tab);
                    return true;
                  }
                }
              } else if (tab.sessionId === ptySessionId) {
                if (
                  tab.resumeId !== agentResumeId
                  || (resumeIdSource && tab.resumeIdSource !== resumeIdSource)
                ) {
                  changed = true;
                }
                tab.resumeId = agentResumeId;
                if (resumeIdSource) tab.resumeIdSource = resumeIdSource;
                return true;
              }
            }
          } else {
            for (const child of node.children) {
              if (update(child)) return true;
            }
          }
          return false;
        };
        eachLayoutTree(state, (_layout, tree) => {
          if (update(tree)) {
            found = true;
          }
        });
      });
      // resumeId 是恢复身份，必须尽快进共享快照——只靠 60s 定时器落盘的话，
      // 异常退出会恢复到旧会话。同值 no-op：daemon 重连会全量重放 identity
      // 事件，不做去重会把重放风暴变成一轮轮无意义的快照写盘。
      if (changed) notifyTerminalLayoutChanged("resume-id.update");
      return found;
    },

    updateTabClaudeSession: (ptySessionId, claudeSessionId) => {
      get().updateTabAgentResumeId(ptySessionId, claudeSessionId);
    },

    setTabResumeBinding: (tabId, resumeId, resumeIdSource) => {
      let changed = false;
      set((state) => {
        const location = findTabAcrossLayouts(state, tabId);
        if (!location || location.tab.contentType !== "terminal") return;
        const tab = location.tab;
        if (tab.terminalRootPane) {
          const leaves = collectTerminalLeaves(tab.terminalRootPane);
          const activeLeaf =
            (tab.activeTerminalPaneId
              ? leaves.find((leaf) => leaf.id === tab.activeTerminalPaneId)
              : null) ?? leaves[0];
          if (activeLeaf) {
            changed = activeLeaf.resumeId !== resumeId;
            activeLeaf.resumeId = resumeId;
            activeLeaf.resumeIdSource = resumeId ? resumeIdSource : undefined;
          }
          syncTabTerminalState(tab);
        } else {
          changed = tab.resumeId !== resumeId;
          tab.resumeId = resumeId;
          tab.resumeIdSource = resumeId ? resumeIdSource : undefined;
        }
      });
      // 与 updateTabAgentResumeId 同理：手动绑定/解绑也要立刻进共享快照。
      if (changed) notifyTerminalLayoutChanged("resume-id.update");
    },

    reconnectTab: async (_paneId, tabId, terminalPaneId) => {
      try {
        await ensureListeners();
        await waitForTerminalRestoreBarrierWithDeadline();
        // 屏障完成后立即重读，避免 reconciliation 已认领/阻断该 leaf 后仍按旧快照重建。
        const location = findTabAcrossLayouts(get(), tabId);
        const tab = location?.tab;
        if (!tab || !tab.projectPath) return null;
        const leafId = terminalPaneId ?? tab.activeTerminalPaneId ?? "";
        const terminalLeaf = tab.contentType === "terminal" && tab.terminalRootPane
          ? findTerminalPane(tab.terminalRootPane, leafId)
          : null;
        const leaf = terminalLeaf?.type === "leaf" ? terminalLeaf : null;
        if (leaf?.restoreBlockedReason) return null;
        if (leaf?.sessionId && !leaf.disconnected) return leaf.sessionId;
        const launchId = generateId("launch");
        get().updateTerminalLaunchId(tabId, leafId, launchId);
        const sessionId = await terminalService.createSession({
          launchId,
          projectPath: tab.projectPath,
          cols: 80,
          rows: 24,
          workspaceName: leaf?.workspaceName ?? tab.workspaceName,
          providerId: leaf?.providerId ?? tab.providerId,
          modelId: leaf?.modelId ?? tab.modelId,
          providerSelection: leaf?.providerSelection ?? tab.providerSelection,
          launchProfileId: leaf?.launchProfileId ?? tab.launchProfileId,
          workspacePath: leaf?.workspacePath ?? tab.workspacePath,
          workspaceSnapshotId: leaf?.workspaceSnapshotId ?? tab.workspaceSnapshotId,
          cliTool: leaf?.cliTool ?? tab.cliTool,
          ssh: leaf?.ssh ?? tab.ssh,
          wsl: leaf?.wsl ?? tab.wsl,
          originLayoutId: location?.layoutId,
          originTabId: tabId,
          originTerminalPaneId: leaf?.id,
        });

        // 更新 tab 的 sessionId 和断连状态
        set((state) => {
          const currentLocation = findTabAcrossLayouts(state, tabId);
          const t = currentLocation?.tab;
          if (!t) return;
          if (t.contentType === "terminal" && t.terminalRootPane) {
            const currentLeaf = findTerminalPane(
              t.terminalRootPane,
              terminalPaneId ?? t.activeTerminalPaneId ?? ""
            );
            if (currentLeaf?.type === "leaf") {
              currentLeaf.sessionId = sessionId;
              currentLeaf.disconnected = false;
            }
            syncTabTerminalState(t);
          } else {
            t.sessionId = sessionId;
            t.disconnected = false;
          }
          // Restore the original SSH tab title after reconnection succeeds.
          if (t.ssh && t.machineName) {
            const name = t.projectPath.split(/[/\\]/).pop() || "Terminal";
            t.title = `[${t.machineName}] ${name}`;
          }
        });

        return sessionId;
      } catch (error) {
        console.error("[reconnectTab] Failed to reconnect:", error);
        return null;
      }
    },

    restoreLiveDaemonSessions: (statuses) => {
      const liveSessionIds = new Set(
        statuses
          .filter((status) => status.status !== "exited")
          .map((status) => status.sessionId)
      );
      if (liveSessionIds.size === 0) return 0;

      let restored = 0;
      set((state) => {
        eachLayoutTree(state, (_layout, tree) => {
          for (const panel of collectPanels(tree)) {
            for (const tab of panel.tabs) {
              if (tab.contentType !== "terminal" || !tab.terminalRootPane) continue;
              let changed = false;
              for (const leaf of collectTerminalLeaves(tab.terminalRootPane)) {
                const savedSessionId = leaf.savedSessionId;
                if (!leaf.restoring || !savedSessionId || !liveSessionIds.has(savedSessionId)) {
                  continue;
                }
                leaf.sessionId = savedSessionId;
                leaf.restoring = false;
                leaf.savedSessionId = undefined;
                leaf.restoreMode = "adopted";
                changed = true;
                restored += 1;
              }
              if (changed) {
                syncTabTerminalState(tab);
              }
            }
          }
        });
      });

      return restored;
    },

    getRestorableTabs: () => {
      set((state) => {
        eachLayoutTree(state, (_layout, tree) => {
          for (const panel of collectPanels(tree)) {
            for (const tab of panel.tabs) {
              if (tab.contentType === "terminal") {
                syncTabTerminalState(tab);
              }
            }
          }
        });
      });

      const result: Array<{ tab: Tab; paneId: string; layoutId: string }> = [];
      eachLayoutTree(get(), (layout, tree) => {
        for (const panel of collectPanels(tree)) {
          for (const tab of panel.tabs) {
            if (tab.contentType === "terminal" && tab.projectPath) {
              result.push({ tab, paneId: panel.id, layoutId: layout.id });
            }
          }
        }
      });
      return result;
    },

    collectReferencedSessionIds: () => {
      const referenced = new Set<string>();
      const state = get();
      // 不用 eachLayoutTree：它跳过星标布局，而星标布局里的 tab 同样引用会话。
      eachLayout(state.layouts, (layout) => {
        const tree = layout.id === state.currentLayoutId ? state.rootPane : layout.rootPane;
        if (!tree) return;
        for (const panel of collectPanels(tree)) {
          for (const tab of panel.tabs) {
            if (tab.contentType !== "terminal") continue;
            if (tab.sessionId) referenced.add(tab.sessionId);
            // tab.savedSessionId 自批5 绞杀后不再物化刷新：有树时该值可能是快照载入的
            // 陈旧拷贝。保护集语义是超集安全（多保护≠误杀），保留读取以覆盖 legacy 形态。
            if (tab.savedSessionId) referenced.add(tab.savedSessionId);
            for (const leaf of collectTerminalLeaves(tab.terminalRootPane)) {
              if (leaf.sessionId) referenced.add(leaf.sessionId);
              if (leaf.savedSessionId) referenced.add(leaf.savedSessionId);
            }
          }
        }
      });
      return referenced;
    },

    setBackgroundRestoreSession: (tabId, terminalPaneId, savedSessionId) => {
      set((state) => {
        const location = findTabAcrossLayouts(state, tabId);
        const tab = location?.tab;
        if (!tab || tab.contentType !== "terminal" || !tab.terminalRootPane) return;
        const leaf = findTerminalPane(tab.terminalRootPane, terminalPaneId);
        if (leaf?.type !== "leaf") return;
        // 后台已为该 leaf 建好会话：写成"可重连的 savedSession"并保持 restoring，
        // 用户切到该布局时 TerminalView 的 deferred 重恢复会 findLiveSavedSessionId 命中并 reattach（不重建）。
        leaf.savedSessionId = savedSessionId;
        leaf.restoring = true;
        leaf.sessionId = null;
        leaf.restoreBlockedReason = undefined;
        leaf.leaseReadOnly = false;
        syncTabTerminalState(tab);
      });
    },

    setSessionLeaseReadOnly: (sessionId, readOnly) => {
      set((state) => {
        eachLayout(state.layouts, (layout) => {
          const tree = layout.id === state.currentLayoutId ? state.rootPane : layout.rootPane;
          if (!tree) return;
          for (const panel of collectPanels(tree)) {
            for (const tab of panel.tabs) {
              if (tab.contentType !== "terminal" || !tab.terminalRootPane) continue;
              let changed = false;
              for (const leaf of collectTerminalLeaves(tab.terminalRootPane)) {
                if (leaf.sessionId !== sessionId && leaf.savedSessionId !== sessionId) continue;
                leaf.leaseReadOnly = readOnly;
                changed = true;
              }
              if (changed) syncTabTerminalState(tab);
            }
          }
        });
      });
    },

    canCreateTerminalSession: (
      tabId,
      terminalPaneId,
      expectedSavedSessionId,
      allowLiveExpectedSession = false,
    ) => {
      const location = findTabAcrossLayouts(get(), tabId);
      const tab = location?.tab;
      if (!tab || tab.contentType !== "terminal" || !tab.terminalRootPane) return false;
      const leaf = findTerminalPane(tab.terminalRootPane, terminalPaneId);
      const savedSessionStatus = expectedSavedSessionId
        ? useTerminalStatusStore.getState().statusMap.get(expectedSavedSessionId)
        : undefined;
      return leaf?.type === "leaf"
        && !leaf.sessionId
        && !leaf.restoreBlockedReason
        && leaf.savedSessionId === expectedSavedSessionId
        && (
          allowLiveExpectedSession
          || !savedSessionStatus
          || savedSessionStatus.status === "exited"
        );
    },

    attachSessionToAnchor: (anchor) => {
      // 历史记录缺任一锚点维度时只允许用户显式接管，绝不做启动自动认领。
      if (
        !anchor.layoutId
        || !anchor.tabId
        || !anchor.terminalPaneId
        || !anchor.expectedProjectPath
      ) return false;
      const layoutId = anchor.layoutId;
      const terminalPaneId = anchor.terminalPaneId;
      const expectedProjectPath = anchor.expectedProjectPath;

      let attached = false;
      set((state) => {
        const location = findTabAcrossLayouts(state, anchor.tabId);
        if (!location) return;
        // 锚点带 layoutId 时必须同布局：tab id 理论上全局唯一，但布局快照互相
        // 覆盖过的历史数据里出现过跨布局同 id，宁可不认领。
        if (location.layoutId !== layoutId) return;

        const tab = location.tab;
        if (tab.contentType !== "terminal" || !tab.terminalRootPane) return;

        // 项目身份必须等价。直接比字符串会把 /mnt/d/x 与 D:\x 判成不同项目，
        // 所以走 projectIdentityKey（与 Rust 侧 canonical_project_path 对齐）。
        if (
          !tab.projectPath
          || !projectPathsEquivalent(expectedProjectPath, tab.projectPath)
        ) {
          return;
        }

        const leaves = collectTerminalLeaves(tab.terminalRootPane);
        const leaf = leaves.find((item) => item.id === terminalPaneId);
        if (!leaf) return;
        // 该格子已有活会话或另一个待恢复会话 → 不覆盖。
        if (leaf.sessionId || (leaf.savedSessionId && leaf.savedSessionId !== anchor.sessionId)) return;

        // 同一 PTY 可以已由目标 leaf 的 savedSessionId 引用（应用重启后的正常形态），
        // 但不得在任何其他 leaf/tab 中重复挂载。
        const duplicateAnchored = someLayout(state.layouts, (layout) => {
          const tree = layout.id === state.currentLayoutId ? state.rootPane : layout.rootPane;
          if (!tree) return false;
          return collectPanels(tree).some((panel) =>
            panel.tabs.some((candidateTab) =>
              candidateTab.contentType === "terminal"
              && collectTerminalLeaves(candidateTab.terminalRootPane).some((candidateLeaf) =>
                !(candidateTab.id === tab.id && candidateLeaf.id === leaf.id)
                && (
                  candidateLeaf.sessionId === anchor.sessionId
                  || candidateLeaf.savedSessionId === anchor.sessionId
                ))));
        });
        if (duplicateAnchored) return;

        leaf.savedSessionId = anchor.sessionId;
        leaf.restoring = true;
        leaf.sessionId = null;
        leaf.restoreMode = "adopted";
        leaf.restoreBlockedReason = undefined;
        leaf.leaseReadOnly = false;
        syncTabTerminalState(tab);
        attached = true;
      });

      return attached;
    },

    adoptSession: (sessionId, meta) => {
      // 已被本实例某个 tab 引用 → 不重复建，直接把既有 tab 交回给调用方聚焦。
      const existing = get().findTabBySessionAcrossLayouts(sessionId);
      if (existing) return existing.tab.id;

      let adoptedTabId: string | null = null;
      set((state) => {
        if (!activateFirstNormalLayout(state)) return;
        const found = findPane(state.rootPane, state.activePaneId);
        const pane = found?.type === "panel" ? found : collectPanels(state.rootPane)[0];
        if (!pane) return;

        const tab = createTab({
          projectId: meta.projectId ?? sessionId,
          projectPath: meta.projectPath,
          workspaceName: meta.workspaceName,
          workspacePath: meta.workspacePath,
          workspaceSnapshotId: meta.workspaceSnapshotId,
          providerId: meta.providerId,
          modelId: meta.modelId,
          providerSelection: meta.providerSelection,
          launchProfileId: meta.launchProfileId,
          cliTool: meta.cliTool,
          resumeId: meta.resumeId,
          customTitle: meta.customTitle,
          ssh: meta.ssh,
          wsl: meta.wsl,
        });
        const leaf = tab.terminalRootPane;
        if (leaf?.type !== "leaf") return;
        // 与 setBackgroundRestoreSession 同形：写成"可重连的 savedSession"，
        // 由 TerminalView 的恢复路径 reattach 到这条已存在的 PTY，不新建。
        leaf.savedSessionId = sessionId;
        leaf.restoring = true;
        leaf.sessionId = null;
        leaf.restoreMode = "adopted";
        syncTabTerminalState(tab);

        pane.tabs.push(tab);
        pane.activeTabId = tab.id;
        state.activePaneId = pane.id;
        adoptedTabId = tab.id;
      });

      if (adoptedTabId) get().autoBindLayoutWorkspaceFromTabs();
      return adoptedTabId;
    },
  };
}

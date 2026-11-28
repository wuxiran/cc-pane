// resume 目标已不存在时撤销死 resume id（CLI 报 "No conversation found" 等）。
// 单独成文件：sessionBindingActions.ts 已在行数基线上。
import { collectPanels, notifyTerminalLayoutChanged, syncTabTerminalState } from "@/lib/paneTree";
import { collectTerminalLeaves } from "@/lib/paneSessions";
import { eachLayoutTree } from "../paneLayoutHelpers";
import type { PanesState } from "../panesStoreTypes";
import type { PanesStoreAccess } from "./storeAccess";

export type ResumeRetireActions = Pick<PanesState, "retireDeadResumeId">;

export function createResumeRetireActions({ set }: Pick<PanesStoreAccess, "set">): ResumeRetireActions {
  return {
    retireDeadResumeId: (ptySessionId, deadResumeId) => {
      let retired: { tabId: string; terminalPaneId: string | null } | null = null;
      set((state) => {
        eachLayoutTree(state, (_layout, tree) => {
          if (retired) return;
          for (const panel of collectPanels(tree)) {
            for (const tab of panel.tabs) {
              if (tab.contentType !== "terminal") continue;
              if (tab.terminalRootPane) {
                for (const leaf of collectTerminalLeaves(tab.terminalRootPane)) {
                  // 只撤仍等于死 id 的 leaf：已换成别的 id（/clear、手动绑定）就不动。
                  if (leaf.sessionId !== ptySessionId || leaf.resumeId !== deadResumeId) continue;
                  leaf.resumeId = undefined;
                  leaf.resumeIdSource = undefined;
                  syncTabTerminalState(tab);
                  retired = { tabId: tab.id, terminalPaneId: leaf.id };
                  return;
                }
              } else if (tab.sessionId === ptySessionId && tab.resumeId === deadResumeId) {
                tab.resumeId = undefined;
                tab.resumeIdSource = undefined;
                retired = { tabId: tab.id, terminalPaneId: null };
                return;
              }
            }
          }
        });
      });
      // 必须立刻进共享快照：否则下次重启仍从快照副本拿到死 id 再 resume 一次。
      if (retired) notifyTerminalLayoutChanged("resume-id.update");
      return retired;
    },
  };
}

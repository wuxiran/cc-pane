import { useMemo } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { TFunction } from "i18next";
import { toast } from "sonner";
import { usePanesStore } from "@/stores";
import { terminalService, getPoppedTabs, markTabReclaimed as popupMarkReclaimed } from "@/services";
import { isTauriRuntime } from "@/services/runtime";
import { handleErrorSilent } from "@/utils";
import { collectTerminalLeaves, collectTerminalSessionIdsFromTree, collectTerminalTabs } from "@/lib/paneSessions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { LayoutEntry } from "@/types";

export interface DeleteSummary {
  layout: LayoutEntry;
  sessionIds: string[];
  poppedTabIds: string[];
  sshCount: number;
  restoringCount: number;
}

export function summarizeLayoutDelete(layout: LayoutEntry): DeleteSummary {
  if (layout.kind === "starred") {
    return {
      layout,
      sessionIds: [],
      poppedTabIds: [],
      sshCount: 0,
      restoringCount: 0,
    };
  }
  const tabs = collectTerminalTabs(layout.rootPane);
  const poppedTabs = getPoppedTabs();
  const poppedTabIds = tabs
    .map((tab) => tab.id)
    .filter((tabId) => poppedTabs.has(tabId));
  let sshCount = 0;
  let restoringCount = 0;

  for (const tab of tabs) {
    if (tab.ssh) sshCount += 1;
    if (tab.restoring) restoringCount += 1;
    if (tab.terminalRootPane) {
      for (const leaf of collectTerminalLeaves(tab.terminalRootPane)) {
        if (leaf.ssh) sshCount += 1;
        if (leaf.restoring) restoringCount += 1;
      }
    }
  }

  return {
    layout,
    sessionIds: collectTerminalSessionIdsFromTree(layout.rootPane),
    poppedTabIds,
    sshCount,
    restoringCount,
  };
}

async function closePoppedWindows(tabIds: string[]) {
  if (!isTauriRuntime()) return;
  const poppedTabs = getPoppedTabs();
  await Promise.all(tabIds.map(async (tabId) => {
    const label = poppedTabs.get(tabId);
    if (!label) return;
    try {
      const win = await WebviewWindow.getByLabel(label);
      await win?.close();
      popupMarkReclaimed(tabId);
    } catch (error) {
      handleErrorSilent(error, "close popup window");
    }
  }));
}

export default function LayoutDeleteDialog({
  summary,
  onClose,
  t,
}: {
  summary: DeleteSummary | null;
  onClose: () => void;
  t: TFunction<"panes">;
}) {
  const deleteLayout = usePanesStore((s) => s.deleteLayout);

  const summaryItems = useMemo(() => {
    if (!summary) return [];
    return [
      t("layoutDeleteActiveTerminals", { count: summary.sessionIds.length }),
      t("layoutDeletePoppedWindows", { count: summary.poppedTabIds.length }),
      t("layoutDeleteSshRestoring", {
        ssh: summary.sshCount,
        restoring: summary.restoringCount,
      }),
    ];
  }, [summary, t]);

  async function confirmDelete() {
    if (!summary) return;
    const { layout, sessionIds, poppedTabIds } = summary;
    try {
      for (const sessionId of sessionIds) {
        terminalService.detachOutput(sessionId);
        terminalService.detachExit(sessionId);
      }
      await Promise.all(sessionIds.map((sessionId) =>
        terminalService.killSession(sessionId).catch((error) => {
          handleErrorSilent(error, "kill layout session");
        })
      ));
      await closePoppedWindows(poppedTabIds);
      deleteLayout(layout.id);
      toast.success(t("layoutDeleted", { name: layout.name }));
    } finally {
      onClose();
    }
  }

  return (
    <Dialog open={summary !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("deleteLayoutTitle", { name: summary?.layout.name ?? "" })}</DialogTitle>
          <DialogDescription>{t("deleteLayoutDescription")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm" style={{ color: "var(--app-text-secondary)" }}>
          <ul className="space-y-1 rounded-md border p-3" style={{ borderColor: "var(--app-border)" }}>
            {summaryItems.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {t("cancel", { ns: "common" })}
          </Button>
          <Button variant="destructive" onClick={confirmDelete}>
            {t("confirmDeleteLayout")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

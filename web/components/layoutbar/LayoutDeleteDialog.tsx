import { useMemo } from "react";
import type { TFunction } from "i18next";
import { toast } from "sonner";
import { usePanesStore } from "@/stores";
import { getPoppedTabs } from "@/services";
import {
  collectTerminalLeaves,
  collectTerminalSessionIdsWithSavedFromTree,
  collectTerminalTabs,
} from "@/lib/paneSessions";
import { phaseOf } from "@/lib/terminalRuntimePhase";
import { destroySessionsDirectly } from "@/lib/tabLifecycle/destroyPipeline";
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
    // phaseOf 消费方（docs/78）：restoring 判定含「savedSessionId 已置、
    // 标志未及置位」的窗口——旧写法只看布尔会少算这段。
    if (phaseOf(tab) === "restoring") restoringCount += 1;
    if (tab.terminalRootPane) {
      for (const leaf of collectTerminalLeaves(tab.terminalRootPane)) {
        if (leaf.ssh) sshCount += 1;
        if (phaseOf(leaf) === "restoring") restoringCount += 1;
      }
    }
  }

  return {
    layout,
    // 杀集必须用含 savedSessionId 的全量口径：恢复中的会话是真实 PTY，
    // 窄口径会让删布局漏杀它们成孤儿（销毁军规见 paneSessions.ts）
    sessionIds: collectTerminalSessionIdsWithSavedFromTree(layout.rootPane),
    poppedTabIds,
    sshCount,
    restoringCount,
  };
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
    const { layout } = summary;
    try {
      // 回收统一走销毁管线（detach 全部 → kill 全部 → 关弹出窗口 →
      // 附属清理），本组件不再自己编排顺序。整层删除的树操作仍由 deleteLayout
      // 一步完成——逐 tab splice 会制造 N 个中间树状态与 notify 风暴。
      //
      // 传 summary.sessionIds 而不是重新遍历树：summary 是打开对话框那一刻
      // 算好的（用户看到的数字就是它），重新遍历会与展示脱节。
      await destroySessionsDirectly(summary.sessionIds, summary.poppedTabIds, "delete-layout");
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

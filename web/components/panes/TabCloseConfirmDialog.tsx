// 关闭标签前的确认框（docs/78 / docs/68 §2.1）。
//
// 为什么需要它：CC-Panes 自述的核心场景是长时无人值守派工，最贵的那类标签
// 恰恰是 `dirty === false` 的——一个跑了两小时的 agent 会话，和一个空终端，
// 改道前待遇完全相同（直接 kill，零提示）。
//
// 形态对齐 LayoutDeleteDialog：**列出具体条目**（哪个标签、什么状态），不是
// 一句「确定吗」——用户要能据此判断该不该关。
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { CloseGuard } from "@/lib/tabLifecycle/registry";

export interface TabCloseConfirmDialogProps {
  /** 非空即打开。由 planTabDestroy 聚合而来。 */
  guards: CloseGuard[];
  onCancel: () => void;
  onConfirm: () => void;
}

export function TabCloseConfirmDialog({
  guards,
  onCancel,
  onConfirm,
}: TabCloseConfirmDialogProps) {
  const { t } = useTranslation(["panes", "common"]);

  const { busyGuards, dirtyGuards } = useMemo(() => ({
    busyGuards: guards.filter((g) => g.kind === "agent-busy"),
    dirtyGuards: guards.filter((g) => g.kind === "editor-dirty"),
  }), [guards]);

  const open = guards.length > 0;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="min-w-0 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("closeTabConfirmTitle")}</DialogTitle>
          <DialogDescription>{t("closeTabConfirmDescription")}</DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-3 text-sm" style={{ color: "var(--app-text-secondary)" }}>
          {busyGuards.length > 0 && (
            <div className="min-w-0">
              <p className="mb-1">{t("closeTabBusyAgents", { count: busyGuards.length })}</p>
              <ul
                className="min-w-0 space-y-1 rounded-md border p-3"
                style={{ borderColor: "var(--app-border)" }}
              >
                {busyGuards.map((g) => (
                  <li key={`${g.tabId}:${g.sessionId}`} className="flex min-w-0 justify-between gap-3">
                    <span className="min-w-0 flex-1 truncate" title={g.tabTitle}>{g.tabTitle}</span>
                    <span
                      className="shrink-0 text-xs"
                      style={{ color: "var(--app-text-tertiary)" }}
                    >
                      {t(`status.${g.status}`, { defaultValue: g.status })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {dirtyGuards.length > 0 && (
            <div className="min-w-0">
              <p className="mb-1">{t("closeTabDirtyEditors", { count: dirtyGuards.length })}</p>
              <ul
                className="min-w-0 space-y-1 rounded-md border p-3"
                style={{ borderColor: "var(--app-border)" }}
              >
                {dirtyGuards.map((g) => (
                  <li key={g.tabId} className="min-w-0 truncate" title={g.tabTitle}>{g.tabTitle}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onCancel}>
            {t("cancel", { ns: "common" })}
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            {t("closeTabConfirmAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

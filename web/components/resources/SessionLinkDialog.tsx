import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { collectTerminalLeaves } from "@/lib/paneSessions";
import { collectPanels } from "@/lib/paneTree";
import { toastErr } from "@/lib/feedback";
import type { SessionLinkRequest } from "@/services/importService";
import { usePanesStore, useWorkspacesStore } from "@/stores";
import { eachLayoutTree } from "@/stores/paneLayoutHelpers";
import type { OpenTerminalOptions, Tab } from "@/types";

function tabHoldsSession(tab: Tab, id: string): string | null | undefined {
  if (tab.terminalRootPane) {
    return collectTerminalLeaves(tab.terminalRootPane).find((leaf) => leaf.resumeId === id)?.id;
  }
  return tab.resumeId === id ? null : undefined;
}

/** 已打开就直接跳过去（无副作用，不需要确认）。返回是否命中。 */
function revealOpenSession(id: string): boolean {
  const store = usePanesStore.getState();
  let hit: { layoutId: string; panelId: string; tabId: string; leafId: string | null } | null = null;
  eachLayoutTree(store, (layout, tree) => {
    if (hit) return;
    for (const panel of collectPanels(tree)) {
      for (const tab of panel.tabs) {
        const leafId = tabHoldsSession(tab, id);
        if (leafId === undefined) continue;
        hit = { layoutId: layout.id, panelId: panel.id, tabId: tab.id, leafId };
        return;
      }
    }
  });
  const target = hit as { layoutId: string; panelId: string; tabId: string; leafId: string | null } | null;
  if (!target) return false;
  if (target.layoutId !== store.currentLayoutId) store.switchLayout(target.layoutId);
  store.setActivePane(target.panelId);
  store.selectTab(target.panelId, target.tabId);
  if (target.leafId) store.setActiveTerminalPane(target.tabId, target.leafId);
  return true;
}

/**
 * 会话深度链接。链接可能来自任何网页，所以恢复前有两道关：project 必须是已注册项目，
 * 且用户要看过 CLI、会话 ID、目录后亲自确认。恢复只传这三个已校验字段。
 */
export default function SessionLinkDialog({
  link,
  onOpenTerminal,
  onDone,
}: {
  link: SessionLinkRequest;
  onOpenTerminal?: (options: OpenTerminalOptions) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation("dialogs");
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (revealOpenSession(link.id)) {
        onDone();
        return;
      }
      await useWorkspacesStore.getState().load();
      if (cancelled) return;
      const owner = useWorkspacesStore
        .getState()
        .workspaces.find((workspace) =>
          workspace.projects.some((project) => project.path === link.project),
        );
      if (!owner || !onOpenTerminal) {
        toastErr(t("sessionLink.unregistered", { path: link.project }));
        onDone();
        return;
      }
      setWorkspaceName(owner.name);
    })().catch((error) => {
      toastErr(String(error));
      onDone();
    });
    return () => {
      cancelled = true;
    };
  }, [link, onDone, onOpenTerminal, t]);

  if (workspaceName === null) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && onDone()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("sessionLink.title")}</DialogTitle>
          <DialogDescription>{t("sessionLink.description")}</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt>CLI</dt>
          <dd>{link.cli}</dd>
          <dt>{t("sessionLink.sessionId")}</dt>
          <dd className="break-all font-mono text-xs">{link.id}</dd>
          <dt>{t("sessionLink.project")}</dt>
          <dd className="break-all font-mono text-xs">{link.project}</dd>
        </dl>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onDone}>
            {t("sessionLink.cancel")}
          </Button>
          <Button
            onClick={() => {
              onOpenTerminal?.({
                path: link.project,
                workspaceName,
                cliTool: link.cli,
                resumeId: link.id,
              });
              onDone();
            }}
          >
            {t("sessionLink.resume")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

import "@/i18n/workbenchTabsResources";
import { ArrowLeft, ArrowRight, Copy, CopyPlus, ExternalLink, Plus, RefreshCw, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { externalBrowserUrl } from "@/lib/browserTabPresentation";
import { horizontalPaneNeighbors } from "@/lib/paneNeighbors";
import { browserService } from "@/services/browserService";
import { terminalPathLinkService } from "@/services/terminalPathLinkService";
import { isTauriRuntime } from "@/services/runtime";
import { usePanesStore } from "@/stores/usePanesStore";
import type { Tab } from "@/types";

export default function WorkbenchTabMenuItems({ tab, paneId, section }: {
  tab: Tab; paneId: string; section: "browser" | "move";
}) {
  const { t } = useTranslation("workbenchTabs");
  const root = usePanesStore((state) => state.rootPane);
  const url = externalBrowserUrl(tab.browserUrl);
  const browser = tab.contentType === "browser" || tab.contentType === "dsh";
  const run = (action: () => void | Promise<void>) => {
    void Promise.resolve().then(action).catch((error) => toast.error(t("failed", { error: String(error) })));
  };
  if (section === "move") {
    const neighbours = horizontalPaneNeighbors(root, paneId);
    return <>
      {neighbours.left && <ContextMenuItem onSelect={() => usePanesStore.getState().moveTab(paneId, neighbours.left!, tab.id)}><ArrowLeft />{t("moveLeft")}</ContextMenuItem>}
      {neighbours.right && <ContextMenuItem onSelect={() => usePanesStore.getState().moveTab(paneId, neighbours.right!, tab.id)}><ArrowRight />{t("moveRight")}</ContextMenuItem>}
    </>;
  }
  const open = (duplicate: boolean) => {
    usePanesStore.getState().openBrowser(duplicate ? tab.browserUrl ?? "about:blank" : "about:blank", duplicate ? tab.title : undefined, undefined, {
      paneId, reuse: false, insertAfterTabId: tab.id, projectPath: tab.projectPath,
      ...(duplicate ? { browserManualTitle: tab.browserManualTitle, browserPageTitle: tab.browserPageTitle, browserFaviconUrl: tab.browserFaviconUrl } : {}),
    });
  };
  return <>
    <ContextMenuItem onSelect={() => open(false)}><Plus />{t("newRight")}</ContextMenuItem>
    {tab.contentType === "browser" && <ContextMenuItem onSelect={() => open(true)}><CopyPlus />{t("duplicate")}</ContextMenuItem>}
    {browser && url && <>
      {isTauriRuntime() && <ContextMenuItem onSelect={() => run(() => browserService.reload(tab.id))}><RefreshCw />{t("reload")}</ContextMenuItem>}
      {isTauriRuntime() && tab.contentType === "browser" && <ContextMenuItem onSelect={() => run(() => browserService.popOut(tab.id))}><ExternalLink />{t("popOut")}</ContextMenuItem>}
      <ContextMenuItem onSelect={() => run(() => navigator.clipboard.writeText(tab.browserUrl!))}><Copy />{t("copyUrl")}</ContextMenuItem>
      <ContextMenuItem onSelect={() => run(() => terminalPathLinkService.openExternalUrl(url))}><ExternalLink />{t("openExternal")}</ContextMenuItem>
    </>}
    {browser && tab.browserManualTitle && <ContextMenuItem onSelect={() => usePanesStore.getState().updateBrowserTab(tab.id, { manualTitle: null })}><RotateCcw />{t("pageTitle")}</ContextMenuItem>}
    <ContextMenuSeparator />
  </>;
}

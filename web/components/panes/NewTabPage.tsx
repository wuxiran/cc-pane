import "@/i18n/newTabPageResources";
import { useState } from "react";
import { ArrowRight, FileDiff, FilePlus2, FileText, FolderTree, Globe2, MessagesSquare, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Tab } from "@/types";
import { normalizeBrowserUrl } from "@/lib/browserUrl";
import { usePanesStore } from "@/stores/usePanesStore";
import { useNewTabActions } from "./useNewTabActions";

/** Local page: no native WebView or remote request exists until a URL is submitted. */
export default function NewTabPage({ tab, paneId }: { tab: Tab; paneId: string }) {
  const { t } = useTranslation("panes");
  const [address, setAddress] = useState("");
  const [error, setError] = useState(false);
  const actions = useNewTabActions(paneId, tab);
  const cards = [
    { key: "review", icon: FileDiff, action: actions.handleAddReview },
    { key: "terminal", icon: Terminal, action: actions.handleAddTerminal },
    { key: "file", icon: FileText, action: actions.handleAddFile },
    { key: "agent", icon: MessagesSquare, action: actions.handleAddAgentChat },
    { key: "page", icon: FilePlus2, action: actions.handleCreatePage },
    { key: "directory", icon: FolderTree, action: actions.handleAddFileExplorer },
  ] as const;

  const navigate = () => {
    try {
      const url = normalizeBrowserUrl(address);
      usePanesStore.getState().updateBrowserTab(tab.id, { browserUrl: url });
      setError(false);
    } catch { setError(true); }
  };

  return <section className="@container flex h-full min-h-0 flex-col bg-[var(--app-content)] text-[var(--app-text-primary)]" aria-label={t("newTabPage.title")}>
    <form onSubmit={(event) => { event.preventDefault(); navigate(); }} className="flex shrink-0 items-center gap-3 border-b border-[var(--app-border)] px-4 py-3">
      <Globe2 className="size-4 shrink-0 text-[var(--app-text-tertiary)]" aria-hidden="true" />
      <input type="text" autoComplete="off" spellCheck={false} aria-label={t("newTabPage.address")}
        placeholder={t("newTabPage.address")} value={address} onChange={(event) => { setAddress(event.target.value); setError(false); }}
        className="h-10 min-w-0 flex-1 rounded-full border border-[var(--app-border)] bg-[var(--app-sidebar)] px-5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]" />
      <button type="submit" disabled={!address.trim()} aria-label={t("newTabPage.go")}
        className="flex size-10 shrink-0 items-center justify-center rounded-full hover:bg-[var(--app-hover)] disabled:opacity-40"><ArrowRight className="size-4" /></button>
    </form>
    <div className="min-h-0 flex-1 overflow-auto p-5 sm:p-8">
      {error && <p role="alert" className="mb-5 text-sm text-[var(--app-status-danger)]">{t("newTabPage.invalidAddress")}</p>}
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">{t("newTabPage.tools")}</h2>
          {actions.projectPath && <span className="max-w-full truncate text-xs text-[var(--app-text-tertiary)]" title={actions.projectPath}>{actions.projectPath}</span>}
        </div>
        <div className="grid grid-cols-1 gap-2 @[560px]:grid-cols-2">
          {cards.map(({ key, icon: Icon, action }) => <button key={key} type="button" aria-label={t(`newTabPage.${key}`)} onClick={() => void action()}
            className="group flex min-w-0 items-center gap-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg-effective)] px-5 py-5 text-left transition-colors hover:bg-[var(--app-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]">
            <Icon className="size-5 shrink-0 text-[var(--app-text-secondary)]" aria-hidden="true" />
            <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{t(`newTabPage.${key}`)}</span>
              <span className="mt-1 block text-xs text-[var(--app-text-tertiary)]">{t(`newTabPage.${key}Hint`)}</span></span>
            <ArrowRight className="size-4 shrink-0 text-[var(--app-text-tertiary)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
          </button>)}
        </div>
      </div>
    </div>
  </section>;
}

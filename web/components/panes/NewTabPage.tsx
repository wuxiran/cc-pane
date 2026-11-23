import "@/i18n/newTabPageResources";
import { useState } from "react";
import { ArrowRight, FileDiff, FilePlus2, FileText, FolderTree, Globe2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Tab } from "@/types";
import { normalizeBrowserUrl } from "@/lib/browserUrl";
import { usePanesStore } from "@/stores/usePanesStore";
import { useDialogStore } from "@/stores/useDialogStore";
import { useNewTabActions } from "./useNewTabActions";
import { launchTerminalInPlace } from "./newTabLaunch";
import NewTabStartSection from "./NewTabStartSection";

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]";
const projectNameOf = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path;

/** Local page: no native WebView or remote request exists until a URL is submitted. */
export default function NewTabPage({ tab, paneId }: { tab: Tab; paneId: string }) {
  const { t } = useTranslation("panes");
  const [address, setAddress] = useState("");
  const [error, setError] = useState(false);
  const actions = useNewTabActions(paneId, tab);
  const { projectPath, layoutId } = actions;
  const tools = [
    { key: "review", icon: FileDiff, action: actions.handleAddReview },
    { key: "file", icon: FileText, action: actions.handleAddFile },
    { key: "page", icon: FilePlus2, action: actions.handleCreatePage },
    { key: "directory", icon: FolderTree, action: actions.handleAddFileExplorer },
  ] as const;
  const launchInPlace = (cliTool: string) =>
    launchTerminalInPlace({ pageTabId: tab.id, paneId, layoutId, projectPath }, cliTool);

  const navigate = () => {
    try {
      const url = normalizeBrowserUrl(address);
      usePanesStore.getState().updateBrowserTab(tab.id, { browserUrl: url });
      setError(false);
    } catch { setError(true); }
  };

  return <section className="@container h-full min-h-0 overflow-auto bg-[var(--app-content)] text-[var(--app-text-primary)]" aria-label={t("newTabPage.title")}>
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-8 px-4 pb-10 pt-[10vh] @[480px]:px-8">
      <header className="min-w-0">
        <h1 className="truncate text-xl font-semibold" title={projectPath || undefined}>
          {projectPath ? projectNameOf(projectPath) : t("newTabPage.title")}
        </h1>
        <p className="mt-1 truncate text-xs text-[var(--app-text-tertiary)]" title={projectPath || undefined}>
          {projectPath || t("newTabPage.noProject")}
        </p>
      </header>

      <NewTabStartSection onLaunchCli={launchInPlace} onTerminal={() => launchInPlace("none")}
        onAgentChat={() => actions.handleAddAgentChat()}
        onMore={() => useDialogStore.getState().openLauncher({ projectPath: projectPath || undefined, targetLayoutId: layoutId })} />

      <section aria-labelledby="new-tab-tools-heading">
        <h2 id="new-tab-tools-heading" className="mb-2 text-xs font-medium text-[var(--app-text-tertiary)]">{t("newTabPage.tools")}</h2>
        <div className="grid grid-cols-1 gap-1 @[480px]:grid-cols-2">
          {tools.map(({ key, icon: Icon, action }) => <button key={key} type="button" aria-label={t(`newTabPage.${key}`)} title={t(`newTabPage.${key}Hint`)}
            onClick={() => void action()}
            className={`group flex min-w-0 items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] ${focusRing}`}>
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-[var(--app-hover)] text-[var(--app-text-secondary)] group-hover:text-[var(--app-text-primary)]">
              <Icon className="size-4" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{t(`newTabPage.${key}`)}</span>
              <span className="block truncate text-xs text-[var(--app-text-tertiary)]">{t(`newTabPage.${key}Hint`)}</span>
            </span>
          </button>)}
        </div>
      </section>

      <form onSubmit={(event) => { event.preventDefault(); navigate(); }}
        className="flex min-w-0 items-center gap-2 rounded-lg border border-[var(--app-border)] px-3 focus-within:ring-2 focus-within:ring-[var(--app-accent)]">
        <Globe2 className="size-4 shrink-0 text-[var(--app-text-tertiary)]" aria-hidden="true" />
        <input type="text" autoComplete="off" spellCheck={false} aria-label={t("newTabPage.address")}
          placeholder={t("newTabPage.address")} value={address} onChange={(event) => { setAddress(event.target.value); setError(false); }}
          className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--app-text-tertiary)]" />
        <button type="submit" disabled={!address.trim()} aria-label={t("newTabPage.go")}
          className={`flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)] disabled:opacity-40 ${focusRing}`}>
          <ArrowRight className="size-4" aria-hidden="true" />
        </button>
      </form>
      {error && <p role="alert" className="-mt-6 text-xs text-[var(--app-status-danger)]">{t("newTabPage.invalidAddress")}</p>}
    </div>
  </section>;
}

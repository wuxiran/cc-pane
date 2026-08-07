import { useEffect, useMemo, useRef, useState } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { Settings, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SegmentedTabs } from "@/components/ui/segmented";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { isTauriRuntime } from "@/services/runtime";
import { useSettingsStore } from "@/stores";
import { useCCChanStore } from "@/stores/useCCChanStore";
import { useBrowserWebviewOverlayStore } from "@/stores/useBrowserWebviewOverlayStore";
import SettingsPaneContent from "./settings/SettingsPaneContent";
import SettingsSearchBox from "./settings/SettingsSearchBox";
import {
  SettingsSearchProvider,
  scrollToSettingsSection,
} from "./settings/SettingsSearchContext";
import SettingsSidebar from "./settings/SettingsSidebar";
import {
  createSettingsDraft,
  SECTION_DRAFT_KEYS,
  type SettingsDraft,
} from "./settings/settingsDraft";
import {
  getSettingsPane,
  getSettingsPageForPane,
  getSettingsPanesForPage,
  getVisibleSettingsPages,
  getVisibleSettingsPanes,
  type SettingsPageId,
  type SettingsPaneId,
} from "./settings/settingsRegistry";
import {
  SETTINGS_NAVIGATE_EVENT,
  type SettingsNavigationTarget,
} from "./settings/settingsNavigation";
import { searchSettings, type SettingsSearchResult } from "./settings/settingsSearch";

interface SettingsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SETTINGS_WEBVIEW_BLOCKER_ID = "settings-panel";

export default function SettingsPanel({ open, onOpenChange }: SettingsPanelProps) {
  const { t } = useTranslation("settings");
  const settings = useSettingsStore((state) => state.settings);
  const saveSettings = useSettingsStore((state) => state.saveSettings);
  const getDefaults = useSettingsStore((state) => state.getDefaults);
  const setBrowserWebviewBlocked = useBrowserWebviewOverlayStore((state) => state.setBlocked);
  const [draft, setDraft] = useState<SettingsDraft>(() => createSettingsDraft(getDefaults()));
  const [activePaneId, setActivePaneId] = useState<SettingsPaneId>("general");
  const [searchQuery, setSearchQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [highlightedSectionId, setHighlightedSectionId] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [resetArmed, setResetArmed] = useState(false);
  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetArmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPaneByPageRef = useRef<Partial<Record<SettingsPageId, SettingsPaneId>>>({
    general: "general",
  });

  useEffect(() => {
    setBrowserWebviewBlocked(SETTINGS_WEBVIEW_BLOCKER_ID, open);
    return () => setBrowserWebviewBlocked(SETTINGS_WEBVIEW_BLOCKER_ID, false);
  }, [open, setBrowserWebviewBlocked]);

  const panes = useMemo(() => getVisibleSettingsPanes({
    isMac: navigator.platform.toUpperCase().includes("MAC"),
    isTauri: isTauriRuntime(),
  }), []);
  const pages = useMemo(() => getVisibleSettingsPages(panes), [panes]);
  const activePane = getSettingsPane(activePaneId);
  const activePage = getSettingsPageForPane(activePaneId);
  const activePagePanes = getSettingsPanesForPage(activePage.id, panes);
  const resettableKeys = SECTION_DRAFT_KEYS[activePaneId];
  const translate = (key: string) => t(key as never);
  const searchResults = useMemo(
    () => searchSettings(panes, translate, appliedQuery),
    // Rebuild translated search documents when the active locale changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appliedQuery, panes, t],
  );
  const matchedSectionIds = useMemo(() => new Set(
    searchResults
      .filter((result) => result.paneId === activePaneId)
      .map((result) => result.targetSectionId),
  ), [activePaneId, searchResults]);

  useEffect(() => {
    lastPaneByPageRef.current[activePage.id] = activePaneId;
  }, [activePage.id, activePaneId]);

  useEffect(() => {
    if (!open) return;
    dirtyRef.current = false;
    setLastSavedAt(null);
    setResetArmed(false);
  }, [open]);

  useEffect(() => {
    if (open && settings && !dirtyRef.current) {
      setDraft(createSettingsDraft(structuredClone(settings)));
    }
  }, [open, settings]);

  useEffect(() => {
    const timer = window.setTimeout(() => setAppliedQuery(searchQuery), 150);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    if (!appliedQuery) {
      setHighlightedSectionId(null);
      return;
    }
    const first = searchResults[0];
    if (!first) return;
    setActivePaneId(first.paneId);
    setHighlightedSectionId(first.targetSectionId);
    scrollToSettingsSection(first.targetSectionId);
  }, [appliedQuery, searchResults]);

  useEffect(() => {
    const handleNavigate = (event: Event) => {
      const target = (event as CustomEvent<SettingsNavigationTarget>).detail;
      if (!panes.some((pane) => pane.id === target.paneId)) return;
      setActivePaneId(target.paneId);
      setSearchQuery("");
      setAppliedQuery("");
      const sectionId = target.targetSectionId ?? `${target.paneId}-root`;
      setHighlightedSectionId(sectionId);
      scrollToSettingsSection(sectionId);
    };
    window.addEventListener(SETTINGS_NAVIGATE_EVENT, handleNavigate);
    return () => window.removeEventListener(SETTINGS_NAVIGATE_EVENT, handleNavigate);
  }, [panes]);

  function updateDraft(next: SettingsDraft) {
    dirtyRef.current = true;
    setDraft(next);
  }

  async function persistDraft(current: SettingsDraft) {
    try {
      const live = useSettingsStore.getState().settings;
      const settingsToSave: SettingsDraft = {
        ...current,
        webAccess: {
          ...current.webAccess,
          passwordSalt: live?.webAccess.passwordSalt ?? current.webAccess.passwordSalt,
          passwordHash: live?.webAccess.passwordHash ?? current.webAccess.passwordHash,
        },
      };
      await useCCChanStore.getState().saveSettings(current.ccchan);
      await saveSettings(settingsToSave);
      try {
        await emitTo("ccchan", "ccchan:settings-updated", useCCChanStore.getState().settings);
      } catch {
        // The companion window may be closed or the app may be running in a browser.
      }
      setLastSavedAt(new Date().toLocaleTimeString());
    } catch (error) {
      toast.error(t("saveFailed", { ns: "common", error }));
    }
  }

  useEffect(() => {
    if (!open || !dirtyRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void persistDraft(draft);
    }, 500);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    };
    // persistDraft intentionally closes over the latest draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, open]);

  function handleClose(nextOpen: boolean) {
    if (!nextOpen && saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      void persistDraft(draft);
    }
    onOpenChange(nextOpen);
  }

  function handleSelectPane(paneId: SettingsPaneId) {
    setActivePaneId(paneId);
    setSearchQuery("");
    setAppliedQuery("");
    setHighlightedSectionId(null);
    setResetArmed(false);
  }

  function handleSelectPage(pageId: SettingsPageId) {
    const pagePanes = getSettingsPanesForPage(pageId, panes);
    const rememberedPaneId = lastPaneByPageRef.current[pageId];
    const nextPane = pagePanes.find((pane) => pane.id === rememberedPaneId) ?? pagePanes[0];
    if (nextPane) handleSelectPane(nextPane.id);
  }

  function handleSelectSearchResult(result: SettingsSearchResult) {
    setActivePaneId(result.paneId);
    setHighlightedSectionId(result.targetSectionId);
    scrollToSettingsSection(result.targetSectionId);
  }

  function handleResetSection() {
    if (!resettableKeys) return;
    if (!resetArmed) {
      setResetArmed(true);
      if (resetArmTimerRef.current) clearTimeout(resetArmTimerRef.current);
      resetArmTimerRef.current = setTimeout(() => setResetArmed(false), 3000);
      return;
    }
    if (resetArmTimerRef.current) clearTimeout(resetArmTimerRef.current);
    setResetArmed(false);
    const defaults = createSettingsDraft(getDefaults());
    const next = { ...draft };
    for (const key of resettableKeys) {
      (next as Record<string, unknown>)[key] = defaults[key];
    }
    updateDraft(next);
    toast.info(t("sectionResetDone"));
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        data-testid="settings-dialog"
        showCloseButton={false}
        className="!flex flex-col !gap-0 overflow-hidden !rounded-lg !p-0 shadow-2xl"
        style={{
          width: "calc(100vw - 32px)",
          height: "calc(100vh - 92px)",
          maxWidth: 980,
          maxHeight: 600,
          background: "var(--app-content)",
        }}
      >
        <DialogHeader className="flex h-12 shrink-0 flex-row items-center gap-2.5 space-y-0 border-b border-[var(--app-border)] bg-[var(--app-panel-bg)] px-3 sm:px-4">
          <span aria-hidden="true" className="hidden size-7 shrink-0 items-center justify-center rounded bg-[var(--app-active-bg)] text-[var(--app-accent)] sm:flex">
            <Settings size={16} />
          </span>
          <DialogTitle className="hidden shrink-0 text-[14px] font-semibold sm:block">{t("title")}</DialogTitle>
          <DialogDescription className="sr-only">{t("panelDescription")}</DialogDescription>
          <SettingsSearchBox
            query={searchQuery}
            results={searchResults}
            onQueryChange={setSearchQuery}
            onSelect={handleSelectSearchResult}
          />
          <button
            type="button"
            aria-label={t("close", { ns: "common" })}
            onClick={() => handleClose(false)}
            className="ml-auto flex size-8 items-center justify-center rounded-md text-[var(--app-text-secondary)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
          >
            <X aria-hidden="true" size={16} />
          </button>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <SettingsSidebar pages={pages} activePageId={activePage.id} onSelect={handleSelectPage} />
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {activePagePanes.length > 1 && (
              <div className="shrink-0 overflow-x-auto border-b border-[var(--app-border)] px-4 py-2.5 sm:px-6">
                <SegmentedTabs<SettingsPaneId>
                  value={activePaneId}
                  onValueChange={handleSelectPane}
                  items={activePagePanes.map((pane) => ({
                    value: pane.id,
                    label: t(pane.titleKey),
                  }))}
                  size="sm"
                  className="min-w-max rounded-md"
                  aria-label={t("paneNavigation")}
                />
              </div>
            )}
            <div className={activePane.layout === "wide" ? "min-h-0 flex-1 overflow-hidden" : "min-h-0 flex-1 overflow-y-auto"}>
              <div className={activePane.layout === "wide" ? "h-full min-h-0" : "mx-auto w-full max-w-[720px] px-4 py-5 sm:px-8 sm:py-6"}>
                <SettingsSearchProvider value={{
                  query: appliedQuery,
                  matchedSectionIds,
                  highlightedSectionId,
                }}>
                  <SettingsPaneContent paneId={activePaneId} draft={draft} updateDraft={updateDraft} />
                </SettingsSearchProvider>
              </div>
            </div>
          </main>
        </div>

        <footer className="flex h-12 shrink-0 items-center justify-between gap-3 border-t border-[var(--app-border)] bg-[var(--app-panel-bg)] px-3 sm:px-4">
          {resettableKeys ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleResetSection}
              className={resetArmed ? "text-[var(--destructive)] hover:text-[var(--destructive)]" : ""}
            >
              {resetArmed ? t("resetSectionConfirm") : t("resetSection")}
            </Button>
          ) : <span />}
          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-[var(--app-text-tertiary)] sm:inline">
              {lastSavedAt ? t("autoSaved", { time: lastSavedAt }) : t("autoSaveHint")}
            </span>
            <Button variant="secondary" size="sm" onClick={() => handleClose(false)}>
              {t("close", { ns: "common" })}
            </Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

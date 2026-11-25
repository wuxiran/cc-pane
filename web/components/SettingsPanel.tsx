import { getCurrentWindowIfTauri } from "@/services/runtime";
import { type CSSProperties, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toastInfo } from "@/lib/feedback";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { isTauriRuntime } from "@/services/runtime";
import { useSettingsStore } from "@/stores";
import { useBrowserWebviewOverlayStore } from "@/stores/useBrowserWebviewOverlayStore";
import UnsavedChangesDialog from "@/components/providers/UnsavedChangesDialog";
import SettingsSearchBox from "./settings/SettingsSearchBox";
import {
  SettingsSearchProvider,
  scrollToSettingsSection,
} from "./settings/SettingsSearchContext";
import SettingsSidebar from "./settings/SettingsSidebar";
import { SettingsPage } from "./settings/layout";
import {
  createSettingsDraft,
  resetSettingsSection,
  SECTION_DRAFT_KEYS,
} from "./settings/settingsDraft";
import { useSettingsAutosave } from "./settings/useSettingsAutosave";
import {
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

const SettingsPaneContent = lazy(() => import("./settings/SettingsPaneContent"));

interface SettingsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** window：独立原生窗口，占满窗口且不压暗；关闭走窗口事件。 */
  presentation?: "dialog" | "window";
}

const SETTINGS_WEBVIEW_BLOCKER_ID = "settings-panel";

const SETTINGS_LAYOUT_STYLE = {
  "--settings-sidebar-width": "clamp(11rem, 20cqw, 15rem)",
  "--settings-content-gutter": "clamp(1rem, 3cqw, 2.5rem)",
} as CSSProperties;

const IS_MAC = typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");

export default function SettingsPanel({ open, onOpenChange, presentation = "dialog" }: SettingsPanelProps) {
  const { t } = useTranslation("settings");
  const isWindow = presentation === "window";
  const getDefaults = useSettingsStore((state) => state.getDefaults);
  const setBrowserWebviewBlocked = useBrowserWebviewOverlayStore((state) => state.setBlocked);
  const { draft, updateDraft, lastSavedAt, flush, discard } = useSettingsAutosave(open);
  // 当前聚焦的分区（搜索/跳转目标）；页面由它推出，页面内所有分区平铺显示。
  const [activePaneId, setActivePaneIdRaw] = useState<SettingsPaneId>("general");
  const setActivePaneId = useCallback((paneId: SettingsPaneId) => {
    setActivePaneIdRaw(paneId);
  }, []);
  const [searchQuery, setSearchQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [highlightedSectionId, setHighlightedSectionId] = useState<string | null>(null);
  const [resetArmed, setResetArmed] = useState(false);
  const [saveCloseFailed, setSaveCloseFailed] = useState(false);
  const resetArmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setBrowserWebviewBlocked(SETTINGS_WEBVIEW_BLOCKER_ID, open);
    return () => setBrowserWebviewBlocked(SETTINGS_WEBVIEW_BLOCKER_ID, false);
  }, [open, setBrowserWebviewBlocked]);

  const panes = useMemo(() => getVisibleSettingsPanes({
    isMac: IS_MAC,
    isTauri: isTauriRuntime(),
  }), []);
  const pages = useMemo(() => getVisibleSettingsPages(panes), [panes]);
  const activePage = getSettingsPageForPane(activePaneId);
  const activePagePanes = getSettingsPanesForPage(activePage.id, panes);
  const multiPanePage = activePagePanes.length > 1;
  const widePage = activePage.id === "usage-stats" || activePagePanes.some((pane) => pane.layout === "wide");
  // 「恢复本页默认」覆盖本页所有带草稿字段的分区
  const resettablePaneIds = activePagePanes
    .map((pane) => pane.id)
    .filter((paneId) => SECTION_DRAFT_KEYS[paneId] !== undefined);
  const translate = (key: string) => t(key as never);
  const searchResults = useMemo(
    () => searchSettings(panes, translate, appliedQuery),
    // Rebuild translated search documents when the active locale changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appliedQuery, panes, t],
  );
  const matchedSectionIds = useMemo(() => new Set(
    searchResults
      .filter((result) => getSettingsPageForPane(result.paneId).id === activePage.id)
      .map((result) => result.targetSectionId),
  ), [activePage.id, searchResults]);

  // 换页回到顶部；同页内的跳转由 scrollToSettingsSection 负责定位。
  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: 0 });
  }, [activePage.id]);

  useEffect(() => {
    if (!open) {
      setSaveCloseFailed(false);
      return;
    }
    setResetArmed(false);
  }, [open]);

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
  }, [appliedQuery, searchResults, setActivePaneId]);

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
  }, [panes, setActivePaneId]);

  const requestCloseRef = useRef<() => void>(() => undefined);
  requestCloseRef.current = () => handleClose(false);
  useEffect(() => {
    if (!isWindow) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "w") {
        event.preventDefault();
        requestCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    const unlisten = getCurrentWindowIfTauri()?.onCloseRequested((event) => {
      event.preventDefault();
      requestCloseRef.current();
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      void unlisten?.then((fn) => fn()).catch(() => undefined);
    };
  }, [isWindow]);

  function closeNow(nextOpen: boolean) {
    if (nextOpen) onOpenChange(true);
    else void flush().then((saved) => {
      if (saved) onOpenChange(false);
      else setSaveCloseFailed(true);
    });
  }

  function handleClose(nextOpen: boolean) {
    if (!nextOpen) {
      closeNow(false);
      return;
    }
    closeNow(nextOpen);
  }

  function selectPaneNow(paneId: SettingsPaneId) {
    setActivePaneId(paneId);
    setSearchQuery("");
    setAppliedQuery("");
    setHighlightedSectionId(null);
    setResetArmed(false);
  }

  function handleSelectPage(pageId: SettingsPageId) {
    if (pageId === activePage.id) return;
    const nextPane = getSettingsPanesForPage(pageId, panes)[0];
    if (nextPane) selectPaneNow(nextPane.id);
  }

  function handleSelectSearchResult(result: SettingsSearchResult) {
    setActivePaneId(result.paneId);
    setHighlightedSectionId(result.targetSectionId);
    scrollToSettingsSection(result.targetSectionId);
  }

  function handleResetSection() {
    if (resettablePaneIds.length === 0) return;
    if (!resetArmed) {
      setResetArmed(true);
      if (resetArmTimerRef.current) clearTimeout(resetArmTimerRef.current);
      resetArmTimerRef.current = setTimeout(() => setResetArmed(false), 3000);
      return;
    }
    if (resetArmTimerRef.current) clearTimeout(resetArmTimerRef.current);
    setResetArmed(false);
    const defaults = createSettingsDraft(getDefaults());
    updateDraft(resettablePaneIds.reduce(
      (next, paneId) => resetSettingsSection(next, defaults, paneId),
      draft,
    ));
    toastInfo(t("sectionResetDone"));
  }

  const pageFooter = (
    <>
      {resettablePaneIds.length > 0 ? (
        <button
          type="button"
          onClick={handleResetSection}
          className={resetArmed
            ? "rounded-sm text-[var(--destructive)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
            : "rounded-sm text-[var(--app-text-tertiary)] underline-offset-2 hover:text-[var(--app-text-secondary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"}
        >
          {resetArmed ? t("resetSectionConfirm") : t("resetSection")}
        </button>
      ) : <span />}
      <span>{lastSavedAt ? t("autoSaved", { time: lastSavedAt }) : t("autoSaveHint")}</span>
    </>
  );

  return (
    <>
    <Dialog open={open} onOpenChange={handleClose} modal={!isWindow}>
      <DialogContent
        data-testid="settings-dialog"
        scaleAnimation={false}
        showCloseButton={false}
        resizable={!isWindow}
        className={isWindow
          ? "!flex flex-col !gap-0 overflow-hidden !rounded-none !border-0 !p-0 !top-0 !left-0 !translate-x-0 !translate-y-0 !shadow-none"
          : "shape-panel !flex flex-col !gap-0 overflow-hidden !rounded-lg !p-0 shadow-2xl"}
        style={{
          ...SETTINGS_LAYOUT_STYLE,
          width: isWindow ? "100vw" : "88vw",
          height: isWindow ? "100vh" : "82vh",
          maxWidth: isWindow ? "100vw" : "calc(100vw - 2rem)",
          maxHeight: isWindow ? "100vh" : "calc(100vh - 2rem)",
          background: "var(--app-content)",
          containerType: "inline-size",
        }}
      >
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <SettingsSidebar
            pages={pages}
            activePageId={activePage.id}
            onSelect={handleSelectPage}
            titlebarInset={isWindow && IS_MAC}
            searchSlot={(
              <SettingsSearchBox
                query={searchQuery}
                results={searchResults}
                onQueryChange={setSearchQuery}
                onSelect={handleSelectSearchResult}
              />
            )}
          />
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <DialogHeader
              data-testid="settings-dialog-header"
              data-tauri-drag-region={isWindow ? true : undefined}
              className="flex h-11 shrink-0 flex-row items-center justify-between gap-3 space-y-0 text-left border-b border-[var(--app-border)] px-4"
            >
              <nav aria-label={t("breadcrumbLabel")} className="flex min-w-0 items-center gap-1.5 text-[length:var(--text-row)]">
                <DialogTitle className="shrink-0 text-[length:var(--text-row)] font-normal text-[var(--app-text-tertiary)]">
                  {t("title")}
                </DialogTitle>
                <span aria-hidden="true" className="text-[var(--app-text-tertiary)]">/</span>
                <span aria-current="page" className="truncate font-medium text-[var(--app-text-primary)]">
                  {t(activePage.titleKey)}
                </span>
                <DialogDescription className="sr-only">{t("panelDescription")}</DialogDescription>
              </nav>
              {!isWindow && (<button
                type="button"
                aria-label={t("close", { ns: "common" })}
                onClick={() => handleClose(false)}
                className="shape-control flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--app-text-secondary)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
              >
                <X aria-hidden="true" size={16} strokeWidth={1.6} />
              </button>)}
            </DialogHeader>
            <div ref={scrollRef} className="app-scrollbar min-h-0 flex-1 overflow-y-auto">
              <div
                data-testid="settings-content-container"
                className="w-full"
                style={{ paddingInline: "var(--settings-content-gutter)" }}
              >
                <SettingsSearchProvider value={{
                  query: appliedQuery,
                  matchedSectionIds,
                  highlightedSectionId,
                }}>
                  <SettingsPage title={t(activePage.titleKey)} wide={widePage} footer={pageFooter}>
                    <Suspense fallback={<div role="status">{t("loading", { ns: "common" })}</div>}>
                      {activePagePanes.map((pane) => (
                        <SettingsPaneContent
                          key={pane.id}
                          paneId={pane.id}
                          draft={draft}
                          updateDraft={updateDraft}
                          legacyTitle={multiPanePage ? t(pane.titleKey) : undefined}
                          legacyDescription={multiPanePage && pane.descriptionKey ? t(pane.descriptionKey) : undefined}
                        />
                      ))}
                    </Suspense>
                  </SettingsPage>
                </SettingsSearchProvider>
              </div>
            </div>
          </main>
        </div>
      </DialogContent>
    </Dialog>
    <UnsavedChangesDialog
      open={saveCloseFailed}
      onCancel={() => setSaveCloseFailed(false)}
      onDiscard={() => { discard(); setSaveCloseFailed(false); onOpenChange(false); }}
    />
    </>
  );
}

import { useEffect, useRef } from "react";
import { Scan } from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePanesStore } from "@/stores/usePanesStore";
import { usePanelPreferencesStore } from "@/stores/usePanelPreferencesStore";
import { autoFitPaneTree } from "@/stores/panes/autoFitLayout";
import { collectPanels } from "@/lib/paneTree";
import { notifyTerminalLayoutChanged } from "@/lib/paneTree";

export function LayoutAutoFitButton() {
  const { t } = useTranslation("panes");
  const id = usePanesStore(s => s.currentLayoutId);
  const enabled = usePanelPreferencesStore(s => Boolean(id && s.autoFitLayouts.includes(id)));
  const setAutoFit = usePanelPreferencesStore(s => s.setAutoFit);
  return <button type="button" title={t("autoFitLayout")} aria-label={t("autoFitLayout")} aria-pressed={enabled}
    className={`flex size-7 shrink-0 items-center justify-center rounded hover:bg-[var(--app-hover)] ${enabled ? "bg-[var(--app-active-bg)] text-[var(--app-accent)]" : ""}`}
    disabled={!id} onClick={() => { if (id) setAutoFit(id, !enabled); }}><Scan className="size-4" /></button>;
}

export function LayoutAutoFitObserver() {
  const marker = useRef<HTMLDivElement>(null);
  const id = usePanesStore(s => s.currentLayoutId);
  const panelKey = usePanesStore(s => collectPanels(s.rootPane).map(p => p.id).join("|"));
  const enabled = usePanelPreferencesStore(s => Boolean(id && s.autoFitLayouts.includes(id)));
  useEffect(() => {
    const host = marker.current?.parentElement;
    if (!host || !enabled || !id) return;
    let timer: ReturnType<typeof setTimeout>;
    const fit = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const s = usePanesStore.getState();
        if (s.currentLayoutId !== id || s.listLayouts().find(l => l.id === id)?.kind === "starred") return;
        const rootPane = autoFitPaneTree(s.rootPane, host.clientWidth, host.clientHeight);
        if (rootPane !== s.rootPane) { usePanesStore.setState({ rootPane }); notifyTerminalLayoutChanged("layout.auto-fit"); }
      }, 120);
    };
    const observer = new ResizeObserver(fit); observer.observe(host); fit();
    return () => { clearTimeout(timer); observer.disconnect(); };
  }, [id, panelKey, enabled]);
  return <div ref={marker} className="pointer-events-none absolute size-0" aria-hidden />;
}

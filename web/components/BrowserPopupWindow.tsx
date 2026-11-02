import { useEffect, useState } from "react";
import { Toaster } from "sonner";
import { getCurrentWindowIfTauri } from "@/services/runtime";
import { browserService, type BrowserHostState } from "@/services/browserService";
import type { Tab } from "@/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import BrowserTabContent from "@/components/panes/BrowserTabContent";

/** A host for the existing native view, never a second browser page. */
export default function BrowserPopupWindow() {
  const [tab, setTab] = useState<Tab | null>(null);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"mini" | "window">("window");
  const [visibility, setVisibility] = useState({ visible: true, active: true });
  useEffect(() => {
    const tabId = new URLSearchParams(location.search).get("tabId");
    if (!tabId) { setError("Browser tab ID is missing"); return; }
    let disposed = false;
    const listeners: Array<() => void> = [];
    const register = (promise: Promise<() => void>) => { void promise.then((stop) => disposed ? stop() : listeners.push(stop)).catch((cause) => setError(String(cause))); };
    let hostRevision = 0;
    const applyHost = (state: BrowserHostState) => {
      if (disposed || state.tabId !== tabId) return;
      setMode(state.mode === "mini" ? "mini" : "window");
      setTab({ id: tabId, title: state.title || "Browser", browserUrl: state.url, contentType: "browser", projectId: "", projectPath: "", sessionId: null });
    };
    const initialRevision = hostRevision;
    void browserService.hostState(tabId).then((state) => { if (hostRevision === initialRevision) applyHost(state); })
      .catch((cause) => { if (!disposed) setError(String(cause)); });
    register(browserService.onHostChanged((state) => { if (state.tabId === tabId) { hostRevision++; applyHost(state); } }));
    register(browserService.onPageLoad((event) => { if (event.tabId === tabId) setTab((current) => current ? { ...current, browserUrl: event.url } : current); }));
    register(browserService.onTitleChanged((event) => {
      if (event.tabId !== tabId) return;
      setTab((current) => current ? { ...current, title: event.title } : current);
      void getCurrentWindowIfTauri()?.setTitle(`${event.title} · CC-Panes`).catch(console.error);
    }));
    const sync = () => setVisibility({ visible: document.visibilityState !== "hidden", active: document.hasFocus() });
    document.addEventListener("visibilitychange", sync); window.addEventListener("focus", sync); window.addEventListener("blur", sync); sync();
    return () => { disposed = true; listeners.forEach((stop) => stop()); document.removeEventListener("visibilitychange", sync); window.removeEventListener("focus", sync); window.removeEventListener("blur", sync); };
  }, []);
  useEffect(() => { if (tab?.title) void getCurrentWindowIfTauri()?.setTitle(`${tab.title} · CC-Panes`).catch(console.error); }, [tab?.title]);
  return <TooltipProvider><div className="h-screen w-screen overflow-hidden bg-[var(--app-content)] text-[var(--app-text-primary)]">
    {error ? <p role="alert" className="p-6 text-sm">{error}</p> : tab ? <BrowserTabContent tab={tab} popup popupMode={mode} popupVisible={visibility.visible} popupActive={visibility.active} /> : <p className="p-6">Loading…</p>}
    <Toaster />
  </div></TooltipProvider>;
}

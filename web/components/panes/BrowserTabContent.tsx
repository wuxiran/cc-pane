import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Code2,
  LoaderCircle,
  LockKeyhole,
  Monitor,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { Tab } from "@/types";
import { usePanesStore } from "@/stores";
import { useBrowserWebviewOverlayStore } from "@/stores/useBrowserWebviewOverlayStore";
import { browserService, type BrowserBounds } from "@/services/browserService";
import { browserSecurityKind, normalizeBrowserUrl } from "@/lib/browserUrl";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { isTauriRuntime } from "@/services/runtime";

interface BrowserTabContentProps {
  tab: Tab;
  isVisible: boolean;
  isActive: boolean;
}

function viewportBounds(node: HTMLDivElement | null): BrowserBounds | null {
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

export default memo(function BrowserTabContent({
  tab,
  isVisible,
  isActive,
}: BrowserTabContentProps) {
  const { t } = useTranslation("panes");
  const viewportRef = useRef<HTMLDivElement>(null);
  const createdRef = useRef(false);
  const webviewBlocked = useBrowserWebviewOverlayStore((state) => state.blockers.size > 0);
  const webviewBlockedRef = useRef(webviewBlocked);
  const previousWebviewBlockedRef = useRef(webviewBlocked);
  webviewBlockedRef.current = webviewBlocked;
  const webviewVisible = isVisible && !webviewBlocked;
  const [address, setAddress] = useState(tab.browserUrl ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const security = browserSecurityKind(address);

  const reportError = useCallback((value: unknown) => {
    const message = value instanceof Error ? value.message : String(value);
    setError(message);
    toast.error(t("browserActionFailed", { error: message }));
  }, [t]);

  const syncBounds = useCallback(() => {
    if (!createdRef.current || !isVisible) return;
    const bounds = viewportBounds(viewportRef.current);
    if (!bounds) return;
    void browserService.setBounds(tab.id, bounds).catch(reportError);
  }, [isVisible, reportError, tab.id]);

  useEffect(() => {
    if (!isTauriRuntime() || !isVisible || createdRef.current) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const bounds = viewportBounds(viewportRef.current);
      if (!bounds || !tab.browserUrl) return;
      const shouldShow = isVisible && !webviewBlockedRef.current;
      void browserService.create(tab.id, tab.browserUrl, bounds, shouldShow)
        .then(() => {
          if (cancelled) {
            void browserService.close(tab.id);
            return;
          }
          createdRef.current = true;
          setError(null);
          const visible = isVisible && !webviewBlockedRef.current;
          void browserService.setVisible(tab.id, visible, visible && isActive).catch(reportError);
        })
        .catch(reportError);
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isActive, isVisible, reportError, tab.browserUrl, tab.id]);

  useEffect(() => {
    return () => {
      if (isTauriRuntime()) {
        void browserService.close(tab.id);
      }
    };
  }, [tab.id]);

  useEffect(() => {
    const restoringFromOverlay = previousWebviewBlockedRef.current && !webviewBlocked;
    previousWebviewBlockedRef.current = webviewBlocked;
    if (!createdRef.current) return;
    void browserService.setVisible(
      tab.id,
      webviewVisible,
      webviewVisible && isActive && !restoringFromOverlay,
    ).catch(reportError);
    if (webviewVisible) syncBounds();
  }, [isActive, reportError, syncBounds, tab.id, webviewBlocked, webviewVisible]);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const observer = new ResizeObserver(syncBounds);
    observer.observe(node);
    window.addEventListener("resize", syncBounds);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncBounds);
    };
  }, [syncBounds]);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    void browserService.onPageLoad((event) => {
      if (event.tabId !== tab.id) return;
      setAddress(event.url);
      setLoading(event.loading);
      usePanesStore.getState().updateBrowserTab(tab.id, { browserUrl: event.url });
    }).then((unlisten) => unlisteners.push(unlisten));
    void browserService.onTitleChanged((event) => {
      if (event.tabId !== tab.id || !event.title.trim()) return;
      usePanesStore.getState().updateBrowserTab(tab.id, { title: event.title });
    }).then((unlisten) => unlisteners.push(unlisten));
    return () => unlisteners.forEach((unlisten) => unlisten());
  }, [tab.id]);

  const navigate = useCallback(() => {
    try {
      const url = normalizeBrowserUrl(address);
      setAddress(url);
      setLoading(true);
      setError(null);
      void browserService.navigate(tab.id, url).catch(reportError);
    } catch (value) {
      reportError(value);
    }
  }, [address, reportError, tab.id]);

  const invokeAction = useCallback((action: () => Promise<void>) => {
    setError(null);
    void action().catch(reportError);
  }, [reportError]);

  const securityLabel = security === "secure"
    ? t("browserSecure")
    : security === "local"
      ? t("browserLocal")
      : t("browserInsecure");
  const SecurityIcon = security === "secure"
    ? LockKeyhole
    : security === "local"
      ? Monitor
      : TriangleAlert;

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col bg-[var(--app-content)]"
      style={{ paddingTop: "var(--notch-bar-height, 0px)" }}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--app-border)] bg-[var(--app-panel-bg)] px-1.5">
        <IconTooltipButton
          label={t("browserBack")}
          className="h-7 w-7 shrink-0"
          onClick={() => invokeAction(() => browserService.back(tab.id))}
        >
          <ArrowLeft className="h-4 w-4" />
        </IconTooltipButton>
        <IconTooltipButton
          label={t("browserForward")}
          className="h-7 w-7 shrink-0"
          onClick={() => invokeAction(() => browserService.forward(tab.id))}
        >
          <ArrowRight className="h-4 w-4" />
        </IconTooltipButton>
        <IconTooltipButton
          label={t("browserReload")}
          className="h-7 w-7 shrink-0"
          onClick={() => invokeAction(() => browserService.reload(tab.id))}
        >
          <RefreshCw className="h-4 w-4" />
        </IconTooltipButton>
        <div className="flex h-7 min-w-0 flex-1 items-center rounded-md border border-[var(--app-border)] bg-[var(--app-content)] px-2 focus-within:ring-1 focus-within:ring-[var(--app-accent)]">
          <SecurityIcon
            className="mr-1.5 h-3.5 w-3.5 shrink-0 text-[var(--app-text-tertiary)]"
            aria-label={securityLabel}
          />
          <input
            aria-label={t("browserAddress")}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") navigate();
            }}
            className="h-full min-w-0 flex-1 bg-transparent text-xs text-[var(--app-text-primary)] outline-none"
            spellCheck={false}
          />
          {loading ? (
            <LoaderCircle
              data-testid="browser-loading"
              className="ml-1 h-3.5 w-3.5 shrink-0 animate-spin text-[var(--app-accent)]"
            />
          ) : null}
        </div>
        <IconTooltipButton
          label={t("browserDevtools")}
          kbd="F12"
          className="h-7 w-7 shrink-0"
          onClick={() => invokeAction(() => browserService.openDevtools(tab.id))}
        >
          <Code2 className="h-4 w-4" />
        </IconTooltipButton>
      </div>
      <div ref={viewportRef} className="relative min-h-0 flex-1 bg-[var(--app-content)]">
        {!isTauriRuntime() ? (
          <div className="flex h-full items-center justify-center px-6 text-sm text-[var(--app-text-secondary)]">
            {t("browserDesktopOnly")}
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center px-6 text-sm text-[var(--app-status-danger)]">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
});

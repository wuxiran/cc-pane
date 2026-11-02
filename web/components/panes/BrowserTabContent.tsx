import { memo, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Code2,
  ExternalLink,
  PanelTop,
  PictureInPicture2,
  Pencil,
  Maximize2,
  Copy,
  LoaderCircle,
  LockKeyhole,
  Monitor,
  MousePointer2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { Tab } from "@/types";
import { usePanesStore } from "@/stores";
import { useBrowserWebviewOverlayStore } from "@/stores/useBrowserWebviewOverlayStore";
import { useTabViewStateStore, viewKey } from "@/stores/useTabViewStateStore";
import { browserService, type BrowserBounds, type BrowserViewportResult, type BrowserWindowMode } from "@/services/browserService";
import { browserSecurityKind, normalizeBrowserUrl } from "@/lib/browserUrl";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import BrowserResizeHandle from "./BrowserResizeHandle";
import BrowserMiniToolbar from "./BrowserMiniToolbar";
import BrowserViewportToolbar, { DEFAULT_BROWSER_PREVIEW, previewScale, type BrowserPreviewSettings } from "./BrowserViewportToolbar";
import { isTauriRuntime } from "@/services/runtime";
import { lazyWithRetry } from "@/lib/lazyRetry";

const BrowserAnnotationPanel = lazyWithRetry(() => import("./BrowserAnnotationPanel"), "BrowserAnnotationPanel");
const BrowserComputerUsePanel = lazyWithRetry(() => import("./BrowserComputerUsePanel"), "BrowserComputerUsePanel");

// A late native create may outlive its React owner, including a same-tab remount.
const browserViewOwners = new Map<string, symbol>();

function closeUnownedBrowser(tabId: string) {
  if (browserViewOwners.has(tabId)) return;
  void browserService.releaseHost(tabId).catch((cause) => console.error("[Browser] Failed to close released view:", cause));
}

interface BrowserTabContentProps {
  tab: Tab;
  popup?: boolean;
  popupMode?: "mini" | "window";
  popupVisible?: boolean;
  popupActive?: boolean;
}

type BrowserError =
  | { kind: "unsupportedProtocol" }
  | { kind: "message"; value: string };

function viewportBounds(node: HTMLDivElement | null): BrowserBounds | null {
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

function isUnsupportedBrowserProtocolError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("unsupported browser url scheme")
    || normalized.includes("browser tabs only support http and https urls");
}

export default memo(function BrowserTabContent({ tab, popup = false, popupMode = "window", popupVisible = true, popupActive = true }: BrowserTabContentProps) {
  const { t } = useTranslation("panes");
  const { t: toolsT } = useTranslation("browserTools");
  const [toolsOpen, setToolsOpen] = useState(false);
  const [annotationOpen, setAnnotationOpen] = useState(false);
  const [detached, setDetached] = useState(false);
  const [detachedMode, setDetachedMode] = useState<BrowserWindowMode>("embedded");
  const [preview, setPreview] = useState<BrowserPreviewSettings | null>(null);
  const mini = popup && popupMode === "mini";
  const activePreview = mini ? null : preview;
  const [actualViewport, setActualViewport] = useState<BrowserViewportResult | null>(null);
  const [available, setAvailable] = useState({ width: 800, height: 600 });
  const stageRef = useRef<HTMLDivElement>(null);
  const viewportSequence = useRef(0);
  const hostSequence = useRef(0);
  const appliedPreview = useRef(false);
  const scale = activePreview ? previewScale(activePreview, { width: available.width - 20, height: available.height - 20 }) : 1;
  const previewFits = !activePreview || (activePreview.width * scale <= available.width && activePreview.height * scale <= available.height);
  const previewRef = useRef({ preview: activePreview, scale });
  previewRef.current = { preview: activePreview, scale };
  // 可见性读单视图（Panel 的 useReportPaneVisibility 对全部 contentType 上报
  // primary），渲染与 webview 焦点都看本视图，不看聚合。条目未登记视为不可见
  // ——webview 创建有 isVisible 门槛，宁可晚一帧创建也不在后台建。
  const primaryVisibility = useTabViewStateStore(
    (s) => s.views[viewKey(tab.id, "primary")]?.visibility,
  );
  const isVisible = previewFits && (popup ? popupVisible : primaryVisibility !== undefined && primaryVisibility !== "hidden");
  const isActive = popup ? popupActive : primaryVisibility === "active";
  const viewportRef = useRef<HTMLDivElement>(null);
  const createdRef = useRef(false);
  const pendingCreates = useRef(0);
  const createSequence = useRef(0);
  const ownerRef = useRef<symbol | null>(null);
  const visibilityRef = useRef({ isVisible, isActive });
  visibilityRef.current = { isVisible, isActive };
  // webview 当前实际加载的 URL。与 `tab.browserUrl` 不同步时必须重新导航——
  // dsh 标签的 URL 是进程重启后 OS 重新分配的端口，没有任何人会去调
  // `navigate()`（那条路只有地址栏走），只认 createdRef 会让 webview 永远停在
  // 上一次的死端口上（`ERR_CONNECTION_REFUSED`，看着像「恢复没生效」）。
  const loadedUrlRef = useRef<string | null>(null);
  const webviewBlocked = useBrowserWebviewOverlayStore((state) => state.blockers.size > 0);
  const webviewBlockedRef = useRef(webviewBlocked);
  const previousWebviewBlockedRef = useRef(webviewBlocked);
  webviewBlockedRef.current = webviewBlocked;
  const webviewVisible = isVisible && !webviewBlocked;
  const [address, setAddress] = useState(tab.browserUrl ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<BrowserError | null>(null);
  const security = browserSecurityKind(address);

  const reportError = useCallback((value: unknown) => {
    setLoading(false);
    const rawMessage = value instanceof Error ? value.message : String(value);
    const unsupportedProtocol = isUnsupportedBrowserProtocolError(rawMessage);
    const message = unsupportedProtocol ? t("browserUnsupportedProtocol") : rawMessage;
    setError(
      unsupportedProtocol
        ? { kind: "unsupportedProtocol" }
        : { kind: "message", value: rawMessage },
    );
    toast.error(
      unsupportedProtocol ? message : t("browserActionFailed", { error: rawMessage }),
    );
  }, [t]);

  const syncBounds = useCallback(() => {
    if (!createdRef.current || !isVisible || detached) return;
    const { preview: config, scale: displayScale } = previewRef.current;
    const rect = viewportBounds(config ? stageRef.current : viewportRef.current);
    if (!rect) return;
    const bounds = config ? { x: rect.x + 16, y: rect.y + 16, width: rect.width - 32, height: rect.height - 32 } : rect;
    if (config || appliedPreview.current) {
      const sequence = ++viewportSequence.current;
      appliedPreview.current = Boolean(config);
      void browserService.setViewport(tab.id, bounds, config ? { width: config.width, height: config.height, scale: displayScale } : null)
        .then((actual) => { if (sequence === viewportSequence.current) setActualViewport(actual); }).catch(reportError);
    } else {
      void browserService.setBounds(tab.id, bounds).catch(reportError);
    }
  }, [detached, isVisible, reportError, tab.id]);

  // Ownership lives for the tab mount, not for URL/focus/visibility effects.
  useEffect(() => {
    const owner = Symbol(tab.id);
    ownerRef.current = owner;
    browserViewOwners.set(tab.id, owner);
    createdRef.current = false;
    loadedUrlRef.current = null;
    pendingCreates.current = 0;
    createSequence.current++;
    setAddress(tab.browserUrl ?? "");
    return () => {
      if (browserViewOwners.get(tab.id) !== owner) return;
      browserViewOwners.delete(tab.id);
      if (isTauriRuntime() && !popup) closeUnownedBrowser(tab.id);
    };
    // The owner is deliberately independent of navigation within this tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, popup]);

  useEffect(() => {
    if (!isTauriRuntime() || !isVisible) return;
    // onPageLoad can normalize the URL before create's IPC promise resolves.
    // An in-flight create already owns that navigation; do not recreate it.
    if ((createdRef.current || pendingCreates.current > 0) && loadedUrlRef.current === tab.browserUrl) return;
    const owner = ownerRef.current;
    const timer = window.setTimeout(() => {
      const bounds = viewportBounds(viewportRef.current);
      if (!bounds || !tab.browserUrl || browserViewOwners.get(tab.id) !== owner) return;
      const targetUrl = tab.browserUrl;
      const sequence = ++createSequence.current;
      const current = () => browserViewOwners.get(tab.id) === owner && createSequence.current === sequence;
      const shouldShow = visibilityRef.current.isVisible && !webviewBlockedRef.current;
      loadedUrlRef.current = targetUrl;
      pendingCreates.current++;
      const attaching = !createdRef.current;
      const operation = createdRef.current
        ? browserService.navigate(tab.id, targetUrl)
        : browserService.create(tab.id, targetUrl, bounds, shouldShow);
      void operation.then(() => {
          if (browserViewOwners.get(tab.id) !== owner) {
            // No successor owns this tab: a genuinely unmounted pending create
            // needs a final close. A successor's native view must stay alive.
            if (!popup) closeUnownedBrowser(tab.id);
            return;
          }
          if (!current()) return;
          createdRef.current = true;
          syncBounds();
          if (!popup && attaching) {
            const hostRequest = hostSequence.current;
            void browserService.hostState(tab.id).then((state) => {
              if (!current() || hostRequest !== hostSequence.current) return;
              setDetached(state.hostWindow !== "main");
              setDetachedMode(state.mode ?? (state.hostWindow === "main" ? "embedded" : "window"));
              if (state.url && /^https?:/.test(state.url)) { loadedUrlRef.current = state.url; setAddress(state.url); usePanesStore.getState().updateBrowserTab(tab.id, { browserUrl: state.url }); }
            }).catch(reportError);
          }
          setAddress(loadedUrlRef.current ?? targetUrl);
          setError(null);
          const visible = visibilityRef.current.isVisible && !webviewBlockedRef.current;
          void browserService.setVisible(tab.id, visible, visible && visibilityRef.current.isActive)
            .catch((cause) => { if (current()) reportError(cause); });
        })
        .catch((value) => {
          if (!current()) return;
          loadedUrlRef.current = null;
          reportError(value);
        })
        .finally(() => {
          if (browserViewOwners.get(tab.id) === owner) pendingCreates.current--;
        });
    }, 0);
    // Cancelling an effect only cancels undispatched work. Ownership above is
    // the sole authority to destroy a native view after async creation.
    return () => window.clearTimeout(timer);
  }, [isVisible, popup, reportError, syncBounds, tab.browserUrl, tab.id]);

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
    const node = stageRef.current;
    if (!node) return;
    const update = () => { const bounds = node.getBoundingClientRect(); setAvailable({ width: Math.max(24, bounds.width - 32), height: Math.max(24, bounds.height - 32) }); };
    const observer = new ResizeObserver(update); observer.observe(node); update();
    return () => observer.disconnect();
  }, [detached]);
  useEffect(() => { syncBounds(); }, [activePreview, scale, syncBounds]);
  useEffect(() => { if (mini) { setToolsOpen(false); setAnnotationOpen(false); } }, [mini]);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let disposed = false;
    const register = (pending: Promise<() => void>) => {
      void pending.then((unlisten) => {
        if (disposed) unlisten();
        else unlisteners.push(unlisten);
      }).catch((cause) => { if (!disposed) reportError(cause); });
    };
    register(browserService.onHostChanged((event) => {
      if (disposed || event.tabId !== tab.id) return;
      hostSequence.current++;
      if (!popup) { setDetached(event.hostWindow !== "main"); setDetachedMode(event.mode ?? (event.hostWindow === "main" ? "embedded" : "window")); if (event.hostWindow === "main") { setActualViewport(null); appliedPreview.current = Boolean(previewRef.current.preview); } }
    }));
    register(browserService.onPageLoad((event) => {
      if (disposed || event.tabId !== tab.id) return;
      setAddress(event.url);
      setLoading(event.loading);
      if (!event.loading && previewRef.current.preview) syncBounds();
      // 页面**自身**的导航（用户点链接、dsh 内部跳转）也会回填 browserUrl。
      // 同步记进 loadedUrlRef，否则创建 effect 会把它当成「外部换了 URL」
      // 而强制导航回去——用户点一下链接就被弹回原页。
      loadedUrlRef.current = event.url;
      usePanesStore.getState().updateBrowserTab(tab.id, { browserUrl: event.url });
    }));
    register(browserService.onTitleChanged((event) => {
      if (disposed || event.tabId !== tab.id) return;
      usePanesStore.getState().updateBrowserTab(tab.id, { ...(event.title.trim() ? { title: event.title } : {}), ...(event.faviconUrl === undefined ? {} : { faviconUrl: event.faviconUrl }) });
    }));
    return () => { disposed = true; unlisteners.forEach((unlisten) => unlisten()); };
  }, [popup, reportError, syncBounds, tab.id]);

  const navigate = useCallback(() => {
    try {
      const url = normalizeBrowserUrl(address);
      setAddress(url);
      setLoading(true);
      setError(null);
      // 与 onPageLoad 同理：地址栏发起的导航不是「外部换 URL」。
      loadedUrlRef.current = url;
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
      {/* 工具栏右键菜单：页面区是原生 webview（右键归系统 webview），
          浏览器动作的一等入口只能落在 React 渲染的工具栏上。 */}
      {mini ? <BrowserMiniToolbar tabId={tab.id} title={tab.title} onError={reportError} /> : <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex h-14 shrink-0 items-center gap-2 border-b border-[var(--app-border)] bg-[var(--app-content)] px-3">
        <div className="flex shrink-0 items-center gap-0.5 rounded-full bg-[var(--app-sidebar)] p-1">
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
        </div>
        <div className="flex h-9 min-w-0 flex-1 items-center rounded-full border border-transparent bg-[var(--app-sidebar)] px-3 focus-within:ring-1 focus-within:ring-[var(--app-accent)]">
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
            className="h-full min-w-0 flex-1 bg-transparent text-center text-[length:var(--text-row)] text-[var(--app-text-primary)] outline-none focus:text-left"
            spellCheck={false}
          />
          {loading ? (
            <LoaderCircle
              data-testid="browser-loading"
              className="ml-1 h-3.5 w-3.5 shrink-0 animate-spin text-[var(--app-accent)]"
            />
          ) : null}
        </div>
        <IconTooltipButton label={toolsT("responsive")} className="h-9 w-9 shrink-0 rounded-full bg-[var(--app-sidebar)]" disabled={!isTauriRuntime() || detached} onClick={() => setPreview((value) => value ? null : DEFAULT_BROWSER_PREVIEW)} aria-pressed={Boolean(preview)}><Maximize2 className="size-4" /></IconTooltipButton>
        <IconTooltipButton label={toolsT("annotate")} className="h-9 w-9 shrink-0 rounded-full bg-[var(--app-sidebar)]" disabled={!isTauriRuntime() || detached} onClick={() => setAnnotationOpen(true)}><Pencil className="size-4" /></IconTooltipButton>
        <IconTooltipButton label={toolsT(popup ? "returnToPanel" : "popOut")} className="h-9 w-9 shrink-0 rounded-full bg-[var(--app-sidebar)]" disabled={!isTauriRuntime()} onClick={() => invokeAction(() => popup ? browserService.reclaim(tab.id) : browserService.popOut(tab.id))}>{popup ? <PanelTop className="size-4" /> : <ExternalLink className="size-4" />}</IconTooltipButton>
        <IconTooltipButton label={toolsT("miniOpen")} className="h-9 w-9 shrink-0 rounded-full bg-[var(--app-sidebar)]" disabled={!isTauriRuntime()} onClick={() => invokeAction(async () => { await browserService.setWindowMode(tab.id, "mini"); })}><PictureInPicture2 className="size-4" /></IconTooltipButton>
        <IconTooltipButton label={toolsT("title")} className={`h-9 w-9 shrink-0 rounded-full ${toolsOpen ? "bg-[var(--app-active-bg)] text-[var(--app-accent)]" : "bg-[var(--app-sidebar)]"}`} disabled={!isTauriRuntime()} onClick={() => setToolsOpen((value) => !value)} aria-pressed={toolsOpen}>
          <MousePointer2 className="size-4" />
        </IconTooltipButton>
        <IconTooltipButton
          label={t("browserDevtools")}
          kbd="F12"
          className="h-9 w-9 shrink-0 rounded-full bg-[var(--app-sidebar)]"
          onClick={() => invokeAction(() => browserService.openDevtools(tab.id))}
        >
          <Code2 className="h-4 w-4" />
        </IconTooltipButton>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44">
          <ContextMenuItem onSelect={() => invokeAction(() => browserService.back(tab.id))}>
            <ArrowLeft /> {t("browserBack")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => invokeAction(() => browserService.forward(tab.id))}>
            <ArrowRight /> {t("browserForward")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => invokeAction(() => browserService.reload(tab.id))}>
            <RefreshCw /> {t("browserReload")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(address)}>
            <Copy /> {t("copyBrowserUrl")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => invokeAction(() => browserService.openDevtools(tab.id))}>
            <Code2 /> {t("browserDevtools")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>}
      {activePreview && !detached && <BrowserViewportToolbar settings={activePreview} actual={actualViewport} onChange={setPreview} onClose={() => setPreview(null)} />}
      {annotationOpen && !mini && <Suspense fallback={null}><BrowserAnnotationPanel tabId={tab.id} url={address} title={tab.title} onClose={() => setAnnotationOpen(false)} /></Suspense>}
      <div className="flex min-h-0 flex-1">
      <div ref={stageRef} className={`relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden ${activePreview ? "bg-[var(--app-sidebar)] p-4" : ""}`}>
      <div ref={viewportRef} style={activePreview ? { width: actualViewport?.displayWidth ?? activePreview.width * scale, height: actualViewport?.displayHeight ?? activePreview.height * scale, flex: "none" } : undefined} className={`relative min-h-0 min-w-0 bg-[var(--app-content)] ${activePreview ? "ring-1 ring-[var(--app-border)]" : "h-full flex-1"}`}>
        {activePreview && !detached && <BrowserResizeHandle tabId={tab.id} settings={activePreview} scale={scale} onChange={setPreview} />}
        {!previewFits && <p role="status" className="p-5 text-sm text-[var(--app-text-secondary)]">{toolsT("previewTooSmall")}</p>}
        {detached ? <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-[var(--app-text-secondary)]">{detachedMode === "mini" ? <PictureInPicture2 className="size-7" /> : <ExternalLink className="size-7" />}<p>{toolsT(detachedMode === "mini" ? "detachedMini" : "detached")}</p><button className="rounded-xl border border-[var(--app-border)] px-4 py-2" onClick={() => invokeAction(() => browserService.reclaim(tab.id))}>{toolsT("returnToPanel")}</button></div> : null}
        {!isTauriRuntime() ? (
          <div className="flex h-full items-center justify-center px-6 text-sm text-[var(--app-text-secondary)]">
            {t("browserDesktopOnly")}
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center px-6 text-sm text-[var(--app-status-danger)]">
            {error.kind === "unsupportedProtocol"
              ? t("browserUnsupportedProtocol")
              : error.value}
          </div>
        ) : null}
      </div>
      </div>
      {toolsOpen && !mini && !detached && isTauriRuntime() && <Suspense fallback={null}><BrowserComputerUsePanel tabId={tab.id} url={tab.browserUrl ?? ""} onClose={() => setToolsOpen(false)} /></Suspense>}
      </div>
    </div>
  );
});

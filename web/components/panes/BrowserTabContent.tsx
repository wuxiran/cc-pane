import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Code2,
  Copy,
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
import { useTabViewStateStore, viewKey } from "@/stores/useTabViewStateStore";
import { browserService, type BrowserBounds } from "@/services/browserService";
import { browserSecurityKind, normalizeBrowserUrl } from "@/lib/browserUrl";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { isTauriRuntime } from "@/services/runtime";

interface BrowserTabContentProps {
  tab: Tab;
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

export default memo(function BrowserTabContent({ tab }: BrowserTabContentProps) {
  const { t } = useTranslation("panes");
  // 可见性读单视图（Panel 的 useReportPaneVisibility 对全部 contentType 上报
  // primary），渲染与 webview 焦点都看本视图，不看聚合。条目未登记视为不可见
  // ——webview 创建有 isVisible 门槛，宁可晚一帧创建也不在后台建。
  const primaryVisibility = useTabViewStateStore(
    (s) => s.views[viewKey(tab.id, "primary")]?.visibility,
  );
  const isVisible = primaryVisibility !== undefined && primaryVisibility !== "hidden";
  const isActive = primaryVisibility === "active";
  const viewportRef = useRef<HTMLDivElement>(null);
  const createdRef = useRef(false);
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
    if (!createdRef.current || !isVisible) return;
    const bounds = viewportBounds(viewportRef.current);
    if (!bounds) return;
    void browserService.setBounds(tab.id, bounds).catch(reportError);
  }, [isVisible, reportError, tab.id]);

  useEffect(() => {
    if (!isTauriRuntime() || !isVisible) return;
    // 已创建**且 URL 没变**才跳过。URL 变了要继续走下去：后端的 `browser_create`
    // 对已存在的 webview 会转成 navigate + setBounds + setVisible
    // （`browser_service.rs::create`），正是这里需要的语义。
    if (createdRef.current && loadedUrlRef.current === tab.browserUrl) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const bounds = viewportBounds(viewportRef.current);
      if (!bounds || !tab.browserUrl) return;
      const targetUrl = tab.browserUrl;
      const shouldShow = isVisible && !webviewBlockedRef.current;
      // 先认领，别等 create 落地：`onPageLoad` 可能抢在 then 之前回填
      // （它带尾斜杠，与这里的原始串不等），后到的 then 再写一次就会让
      // 下一轮 effect 判成「又变了」而重复导航。
      loadedUrlRef.current = targetUrl;
      void browserService.create(tab.id, targetUrl, bounds, shouldShow)
        .then(() => {
          if (cancelled) {
            void browserService.close(tab.id);
            return;
          }
          createdRef.current = true;
          // 地址栏跟着走：URL 由外部换掉时（dsh 重启换端口）用户看到的
          // 应该是新地址，而不是那个已经连不上的旧端口。
          setAddress(targetUrl);
          setError(null);
          const visible = isVisible && !webviewBlockedRef.current;
          void browserService.setVisible(tab.id, visible, visible && isActive).catch(reportError);
        })
        .catch((value) => {
          // 认领要撤回，否则这个 URL 再也不会被重试（effect 会一直判「没变」）。
          loadedUrlRef.current = null;
          reportError(value);
        });
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
      // 页面**自身**的导航（用户点链接、dsh 内部跳转）也会回填 browserUrl。
      // 同步记进 loadedUrlRef，否则创建 effect 会把它当成「外部换了 URL」
      // 而强制导航回去——用户点一下链接就被弹回原页。
      loadedUrlRef.current = event.url;
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
      <ContextMenu>
        <ContextMenuTrigger asChild>
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
      </ContextMenu>
      <div ref={viewportRef} className="relative min-h-0 flex-1 bg-[var(--app-content)]">
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
  );
});

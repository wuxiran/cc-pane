import { Component, type ReactNode, type ErrorInfo } from "react";
import { AlertTriangle, FolderOpen, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import i18n from "@/i18n";
import { logService } from "@/services/logService";
import { recordFrontendCrash } from "@/utils/frontendCrashLog";

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
  /** Custom fallback node. When provided, it replaces the default error UI.
   *  Useful for small/transparent windows (e.g. the 120x120 ccchan window)
   *  where the default icon + button layout would be clipped. */
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  crashLogDir: string | null;
  crashLogStatus: "idle" | "pending" | "written" | "failed";
  retryPending: boolean;
}

const MODULE_LOAD_ERROR_PATTERN =
  /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|failed to load module script|unable to preload css|^loading chunk \S+ failed\b/i;

type RetryResult = "reset" | "reload" | "unavailable";
type PageLocation = Pick<Location, "href" | "protocol">;
type PageFetcher = (url: string, init: RequestInit) => Promise<Pick<Response, "ok">>;

function requiresPageReload(error: Error): boolean {
  return error.name === "ChunkLoadError" || MODULE_LOAD_ERROR_PATTERN.test(error.message);
}

export async function canReloadPage(
  location: PageLocation,
  fetchPage: PageFetcher = (url, init) => fetch(url, init),
  timeoutMs = 3_000,
): Promise<boolean> {
  if (!/^https?:$/.test(location.protocol)) return true;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchPage(location.href, {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

const canReloadCurrentPage = () => canReloadPage(window.location);

export async function retryAfterError(
  error: Error | null,
  reset: () => void,
  reload: () => void = () => window.location.reload(),
  canReload: () => Promise<boolean> = canReloadCurrentPage,
): Promise<RetryResult> {
  // React.lazy caches rejected imports, so resetting the boundary alone cannot retry them.
  if (error && requiresPageReload(error)) {
    if (!(await canReload())) return "unavailable";
    reload();
    return "reload";
  }
  reset();
  return "reset";
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = {
    hasError: false,
    error: null,
    crashLogDir: null,
    crashLogStatus: "idle",
    retryPending: false,
  };

  private mounted = true;
  private retryInProgress = false;

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
      crashLogDir: null,
      crashLogStatus: "pending",
      retryPending: false,
    };
  }

  componentWillUnmount() {
    this.mounted = false;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
    recordFrontendCrash({
      source: "react-error-boundary",
      error,
      componentStack: info.componentStack ?? undefined,
    })
      .then(({ logDir, written }) => {
        if (!this.mounted) return;
        this.setState({
          crashLogDir: logDir,
          crashLogStatus: written ? "written" : "failed",
        });
      })
      .catch((logError) => {
        console.error("[ErrorBoundary] Failed to record frontend crash:", logError);
        if (!this.mounted) return;
        this.setState({ crashLogStatus: "failed" });
      });
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      crashLogDir: null,
      crashLogStatus: "idle",
      retryPending: false,
    });
  };

  handleRetry = async () => {
    if (this.retryInProgress) return;
    this.retryInProgress = true;
    this.setState({ retryPending: true });
    try {
      const result = await retryAfterError(this.state.error, this.handleReset);
      if (result === "unavailable") {
        console.warn("[ErrorBoundary] Retry skipped because the page origin is unavailable");
      }
    } finally {
      this.retryInProgress = false;
      if (this.mounted) this.setState({ retryPending: false });
    }
  };

  handleOpenLogDir = async () => {
    try {
      await logService.openLogDir();
    } catch (error) {
      console.error("[ErrorBoundary] Failed to open log dir:", error);
    }
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback !== undefined) {
        return <>{this.props.fallback}</>;
      }
      return (
        <div className="flex flex-col items-center justify-center h-full p-8 text-center gap-4">
          <AlertTriangle className="w-10 h-10 text-destructive opacity-60" />
          <div>
            <h3 className="text-sm font-medium mb-1">
              {this.props.fallbackTitle || i18n.t("errorOccurred")}
            </h3>
            <p className="text-xs text-muted-foreground max-w-md break-all">
              {this.state.error?.message}
            </p>
            <p className="mt-2 text-xs text-muted-foreground max-w-md">
              {this.state.crashLogStatus === "pending" && i18n.t("errorLogWriting")}
              {this.state.crashLogStatus === "failed" && i18n.t("errorLogFailed")}
              {this.state.crashLogStatus === "written" && (
                <>
                  {i18n.t("errorLogWritten")}
                  {this.state.crashLogDir && (
                    <span className="block mt-1 font-mono break-all">
                      {this.state.crashLogDir}
                    </span>
                  )}
                </>
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={this.handleRetry}
              disabled={this.state.crashLogStatus === "pending" || this.state.retryPending}
            >
              <RotateCcw size={14} className="mr-1" />
              {i18n.t("retry")}
            </Button>
            <Button size="sm" variant="outline" onClick={this.handleOpenLogDir}>
              <FolderOpen size={14} className="mr-1" />
              {i18n.t("settings:openLogDir")}
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

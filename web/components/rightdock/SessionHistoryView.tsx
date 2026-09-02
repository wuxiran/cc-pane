import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, History, LoaderCircle, Play, RefreshCw, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { sessionIndexService } from "@/services/sessionIndexService";
import { useSshMachinesStore } from "@/stores/useSshMachinesStore";
import type {
  OpenTerminalOptions,
  SessionIndexCliTool,
  SessionIndexEntry,
  SessionIndexListParams,
  SessionIndexScope,
  SshMachine,
  Workspace,
  WorkspaceProject,
} from "@/types";
import { buildLaunchRecordTerminalOptions } from "@/utils";
import type { LaunchRecord } from "@/services";

const PAGE_SIZE = 100;
const SEARCH_DEBOUNCE_MS = 300;
const SESSION_CLI_FILTERS = ["claude", "codex", "pi", "omp"] as const;

type RolloutStatus = "checking" | "valid" | "invalid" | "unknown";

interface SessionHistoryViewProps {
  workspaces: Workspace[];
  workspace: Workspace | null;
  project: WorkspaceProject | null;
  onOpenTerminal: (options: OpenTerminalOptions) => void;
}

function availableScope(
  selected: SessionIndexScope,
  workspace: Workspace | null,
  project: WorkspaceProject | null,
): SessionIndexScope {
  if (selected === "project" && !project) return workspace ? "workspace" : "all";
  if (selected === "workspace" && !workspace) return "all";
  return selected;
}

function buildListParams(
  scope: SessionIndexScope,
  workspace: Workspace | null,
  project: WorkspaceProject | null,
  query: string,
  cliFilter: SessionIndexCliTool | null,
  offset: number,
): SessionIndexListParams {
  return {
    scope,
    ...(scope === "workspace" && workspace ? { workspaceName: workspace.name } : {}),
    ...(scope === "project" && project ? { projectPath: project.path } : {}),
    ...(query ? { query } : {}),
    ...(cliFilter ? { cliFilter } : {}),
    limit: PAGE_SIZE,
    offset,
  };
}

export function buildSessionHistoryTerminalOptions(
  entry: SessionIndexEntry,
  workspaces: Workspace[],
  machines: SshMachine[],
): OpenTerminalOptions {
  const record: LaunchRecord = {
    id: -1,
    projectId: entry.projectPathNorm,
    projectName: entry.projectName,
    projectPath: entry.projectPathNorm || entry.cwd,
    launchedAt: new Date(entry.mtimeMs).toISOString(),
    resumeSessionId: entry.sessionId,
    cliTool: entry.cliTool,
    runtimeKind: entry.source === "wsl" ? "wsl" : "local",
    wslDistro: entry.wslDistro ?? undefined,
    workspaceName: entry.workspaceName ?? undefined,
    launchCwd: entry.cwd,
  };
  const base = buildLaunchRecordTerminalOptions(record, workspaces, machines);
  const options: OpenTerminalOptions = {
    ...base,
    path: entry.cwd || base.path,
    cliTool: entry.cliTool,
    resumeId: entry.sessionId,
  };
  if (entry.source === "wsl") {
    options.wsl = {
      remotePath: entry.cwd || base.wsl?.remotePath || entry.projectPathNorm,
      distro: entry.wslDistro ?? base.wsl?.distro,
    };
  }
  return options;
}

function formatRelativeTime(timestamp: number, language: string): string {
  const elapsedSeconds = Math.round((timestamp - Date.now()) / 1000);
  const absoluteSeconds = Math.abs(elapsedSeconds);
  let value = elapsedSeconds;
  let unit: Intl.RelativeTimeFormatUnit = "second";
  if (absoluteSeconds >= 86_400) {
    value = Math.round(elapsedSeconds / 86_400);
    unit = "day";
  } else if (absoluteSeconds >= 3_600) {
    value = Math.round(elapsedSeconds / 3_600);
    unit = "hour";
  } else if (absoluteSeconds >= 60) {
    value = Math.round(elapsedSeconds / 60);
    unit = "minute";
  }
  return new Intl.RelativeTimeFormat(language, { numeric: "auto" }).format(value, unit);
}

export default function SessionHistoryView({
  workspaces,
  workspace,
  project,
  onOpenTerminal,
}: SessionHistoryViewProps) {
  const { t, i18n } = useTranslation("sidebar");
  const machines = useSshMachinesStore((state) => state.machines);
  const [scope, setScope] = useState<SessionIndexScope>(() => (
    project ? "project" : workspace ? "workspace" : "all"
  ));
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [cliFilter, setCliFilter] = useState<SessionIndexCliTool | null>(null);
  const [sessions, setSessions] = useState<SessionIndexEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [rolloutStatuses, setRolloutStatuses] = useState<Record<string, RolloutStatus>>({});
  const requestId = useRef(0);
  const rolloutRequests = useRef(new Map<string, Promise<boolean>>());
  const effectiveScope = availableScope(scope, workspace, project);
  const queryParams = useMemo(
    () => buildListParams(
      effectiveScope,
      workspace,
      project,
      debouncedSearch,
      cliFilter,
      0,
    ),
    [effectiveScope, workspace, project, debouncedSearch, cliFilter],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    setLoadFailed(false);
    sessionIndexService.list(queryParams).then((result) => {
      if (requestId.current !== currentRequest) return;
      setSessions(result);
      setHasMore(result.length === PAGE_SIZE);
    }).catch(() => {
      if (requestId.current !== currentRequest) return;
      setSessions([]);
      setHasMore(false);
      setLoadFailed(true);
    }).finally(() => {
      if (requestId.current === currentRequest) setLoading(false);
    });
    return () => {
      if (requestId.current === currentRequest) requestId.current += 1;
    };
  }, [queryParams, reloadVersion]);

  const handleLoadMore = useCallback(async () => {
    const currentRequest = requestId.current;
    setLoadingMore(true);
    try {
      const result = await sessionIndexService.list({
        ...queryParams,
        offset: sessions.length,
      });
      if (requestId.current !== currentRequest) return;
      setSessions((current) => [...current, ...result]);
      setHasMore(result.length === PAGE_SIZE);
    } catch {
      toast.error(t("sessionHistory.loadError"));
    } finally {
      setLoadingMore(false);
    }
  }, [queryParams, sessions.length, t]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await sessionIndexService.refresh();
      setRolloutStatuses({});
      setReloadVersion((version) => version + 1);
    } catch {
      toast.error(t("sessionHistory.refreshError"));
    } finally {
      setRefreshing(false);
    }
  }, [t]);

  const checkCodexRollout = useCallback((entry: SessionIndexEntry): Promise<boolean> => {
    const existing = rolloutRequests.current.get(entry.sessionId);
    if (existing) return existing;
    setRolloutStatuses((current) => ({ ...current, [entry.sessionId]: "checking" }));
    const request = sessionIndexService.checkCodexRollout(
      entry.sessionId,
      entry.wslDistro ?? undefined,
    ).then((result) => {
      if (result === false) {
        setRolloutStatuses((current) => ({ ...current, [entry.sessionId]: "invalid" }));
        toast.warning(t("sessionHistory.rolloutMissing"));
        return false;
      }
      if (result === null) {
        setRolloutStatuses((current) => ({ ...current, [entry.sessionId]: "unknown" }));
        toast.warning(t("sessionHistory.rolloutCheckFailed"));
        return true;
      }
      setRolloutStatuses((current) => ({ ...current, [entry.sessionId]: "valid" }));
      return true;
    }).catch(() => {
      setRolloutStatuses((current) => ({ ...current, [entry.sessionId]: "unknown" }));
      toast.warning(t("sessionHistory.rolloutCheckFailed"));
      return true;
    }).finally(() => {
      rolloutRequests.current.delete(entry.sessionId);
    });
    rolloutRequests.current.set(entry.sessionId, request);
    return request;
  }, [t]);

  const handleResume = useCallback(async (entry: SessionIndexEntry) => {
    if (rolloutStatuses[entry.sessionId] === "invalid") return;
    if (entry.cliTool === "codex" && !(await checkCodexRollout(entry))) return;
    onOpenTerminal(buildSessionHistoryTerminalOptions(entry, workspaces, machines));
  }, [checkCodexRollout, machines, onOpenTerminal, rolloutStatuses, workspaces]);

  const language = i18n.resolvedLanguage ?? i18n.language;
  const scopeOptions: SessionIndexScope[] = ["all", "workspace", "project"];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-2 border-b border-[var(--app-border)] px-2 pb-2">
        <div
          role="group"
          aria-label={t("sessionHistory.scopeLabel")}
          className="grid h-8 grid-cols-3 overflow-hidden rounded-md border border-[var(--app-border)] bg-[var(--app-content)]"
        >
          {scopeOptions.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={effectiveScope === option}
              disabled={(option === "workspace" && !workspace) || (option === "project" && !project)}
              onClick={() => setScope(option)}
              className="min-w-0 px-1 text-[11px] text-[var(--app-text-secondary)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)] aria-pressed:bg-[var(--app-active-bg)] aria-pressed:text-[var(--app-text-primary)] disabled:opacity-40"
            >
              <span className="block truncate">{t(`sessionHistory.scope.${option}` as never)}</span>
            </button>
          ))}
        </div>

        <div className="flex h-8 items-center gap-1.5">
          <div className="flex min-w-0 flex-1 items-center rounded-md border border-[var(--app-border)] bg-[var(--app-content)] px-2 focus-within:ring-1 focus-within:ring-[var(--app-accent)]">
            <Search aria-hidden="true" className="size-3.5 shrink-0 text-[var(--app-text-tertiary)]" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("sessionHistory.searchPlaceholder")}
              className="h-7 min-w-0 flex-1 bg-transparent px-1.5 text-[12px] text-[var(--app-text-primary)] outline-none placeholder:text-[var(--app-text-tertiary)]"
            />
            {search && (
              <button
                type="button"
                aria-label={t("sessionHistory.clearSearch")}
                onClick={() => setSearch("")}
                className="flex size-6 shrink-0 items-center justify-center text-[var(--app-text-tertiary)] hover:text-[var(--app-text-primary)]"
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
            )}
          </div>
          <button
            type="button"
            aria-label={t("sessionHistory.refresh")}
            title={t("sessionHistory.refresh")}
            disabled={refreshing}
            onClick={() => void handleRefresh()}
            className="flex size-8 shrink-0 items-center justify-center rounded-md border border-[var(--app-border)] text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)] disabled:opacity-50"
          >
            <RefreshCw aria-hidden="true" className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
          </button>
        </div>

        <div className="flex items-center gap-1.5" aria-label={t("sessionHistory.cliFilter")}>
          {SESSION_CLI_FILTERS.map((cli) => (
            <button
              key={cli}
              type="button"
              aria-pressed={cliFilter === cli}
              onClick={() => setCliFilter((current) => current === cli ? null : cli)}
              className="h-6 rounded-md border border-[var(--app-border)] px-2 text-[11px] font-medium capitalize text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)] aria-pressed:border-[var(--app-accent)] aria-pressed:bg-[var(--app-active-bg)] aria-pressed:text-[var(--app-text-primary)]"
            >
              {t(`sessionHistory.cli.${cli}` as never)}
            </button>
          ))}
        </div>
      </div>

      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-[12px] text-[var(--app-text-tertiary)]">
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
            <span>{t("sessionHistory.loading")}</span>
          </div>
        ) : loadFailed ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-5 text-center">
            <AlertTriangle aria-hidden="true" className="size-5 text-[var(--app-status-warning)]" />
            <p className="text-[12px] text-[var(--app-text-secondary)]">{t("sessionHistory.loadError")}</p>
            <button
              type="button"
              onClick={() => setReloadVersion((version) => version + 1)}
              className="h-7 rounded-md border border-[var(--app-border)] px-2.5 text-[11px] text-[var(--app-text-primary)] hover:bg-[var(--app-hover)]"
            >
              {t("sessionHistory.retry")}
            </button>
          </div>
        ) : sessions.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-5 text-center text-[var(--app-text-tertiary)]">
            <History aria-hidden="true" className="size-5" />
            <p className="text-[12px]">{t("sessionHistory.empty")}</p>
          </div>
        ) : (
          <div className="divide-y divide-[var(--app-border)]">
            {sessions.map((entry) => {
              const rolloutStatus = rolloutStatuses[entry.sessionId];
              const invalid = rolloutStatus === "invalid";
              const checking = rolloutStatus === "checking";
              const summary = entry.lastSummary || entry.firstPrompt || t("sessionHistory.untitled");
              return (
                <article key={entry.sessionId} className="px-2.5 py-2.5 hover:bg-[var(--app-hover)]">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-[12px] leading-5 text-[var(--app-text-primary)]" title={summary}>
                        {summary}
                      </p>
                      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px] text-[var(--app-text-tertiary)]">
                        <span className="rounded-md bg-[var(--app-active-bg)] px-1.5 py-0.5 font-medium capitalize text-[var(--app-text-secondary)]">
                          {entry.cliTool}
                        </span>
                        <span>{t("sessionHistory.messages", { count: entry.messageCount })}</span>
                        <span aria-hidden="true">·</span>
                        <time title={new Date(entry.mtimeMs).toLocaleString(language)}>
                          {formatRelativeTime(entry.mtimeMs, language)}
                        </time>
                        <span aria-hidden="true">·</span>
                        <span className="max-w-full truncate" title={entry.projectName}>
                          {entry.projectName || t("sessionHistory.unknownProject")}
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={invalid || checking}
                      aria-busy={checking}
                      onClick={() => void handleResume(entry)}
                      className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-[var(--app-border)] px-2 text-[11px] font-medium text-[var(--app-text-primary)] hover:bg-[var(--app-active-bg)] disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      {checking
                        ? <LoaderCircle aria-hidden="true" className="size-3 animate-spin" />
                        : <Play aria-hidden="true" className="size-3" />}
                      <span>{t("sessionHistory.resume")}</span>
                    </button>
                  </div>
                  {invalid && (
                    <p role="alert" className="mt-1.5 flex items-center gap-1 text-[10px] text-[var(--app-status-warning)]">
                      <AlertTriangle aria-hidden="true" className="size-3 shrink-0" />
                      <span>{t("sessionHistory.rolloutMissing")}</span>
                    </p>
                  )}
                </article>
              );
            })}
            {hasMore && (
              <div className="p-2">
                <button
                  type="button"
                  disabled={loadingMore}
                  onClick={() => void handleLoadMore()}
                  className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md text-[11px] text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)] disabled:opacity-50"
                >
                  {loadingMore && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
                  <span>{t("sessionHistory.loadMore")}</span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

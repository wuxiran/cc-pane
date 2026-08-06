import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { CircleAlert, LockKeyhole, RotateCcw, Terminal, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Tab, TerminalLaunchError, TerminalPaneNode } from "@/types";
import {
  terminalRestoreLogKey,
  usePanesStore,
  useTerminalRestoreLogStore,
} from "@/stores";
import type { TerminalRestoreLogEntry } from "@/stores/useTerminalRestoreLogStore";
import { Button } from "@/components/ui/button";
import { classifyTerminalLaunchPath, translateError } from "@/utils";
import SplitView from "./SplitView";
import { formatRestoreLogEntry, restoreLogToneColor } from "./terminalRestoreLogFormat";
import TerminalView from "./TerminalView";
import type { TerminalViewHandle } from "./TerminalView";
import VoiceInputButton from "./VoiceInputButton";

interface TerminalTabContentProps {
  tab: Tab;
  isVisible: boolean;
  isActive: boolean;
  layoutActive: boolean;
  onSessionCreated: (sessionId: string, terminalPaneId?: string) => void;
  onSessionExited?: (exitCode: number, terminalPaneId?: string) => void;
  onTerminalRef: (terminalPaneId: string, ref: TerminalViewHandle | null) => void;
  onReconnect?: (terminalPaneId: string) => Promise<string | null>;
}

function normalizeSizes(sizes: number[]): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= 0 || sizes.length === 0) return sizes;
  const rounded = sizes.map((size) => Math.round((size / total) * 1000) / 10);
  const sum = rounded.slice(0, -1).reduce((acc, size) => acc + size, 0);
  rounded[rounded.length - 1] = Math.round((100 - sum) * 10) / 10;
  return rounded;
}

function RestoreLogSurface({ entries }: { entries: TerminalRestoreLogEntry[] }) {
  const { t } = useTranslation("panes");
  const [showRaw, setShowRaw] = useState(false);
  const formatted = useMemo(
    () => entries.map((entry) => ({ id: entry.id, ...formatRestoreLogEntry(entry, t) })),
    [entries, t],
  );
  return (
    <div className="flex min-h-0 w-full flex-col overflow-hidden border-t border-[var(--app-border)]">
      <div className="flex items-center gap-2 px-3 py-2">
        <Terminal className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="text-xs font-medium text-foreground">{t("restoreLogTitle")}</span>
        <button
          type="button"
          aria-pressed={showRaw}
          onClick={() => setShowRaw((value) => !value)}
          className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px] leading-4 hover:bg-[var(--app-hover)]"
          style={{ color: showRaw ? "var(--app-text-primary)" : "var(--app-text-tertiary)" }}
        >
          {t("restoreLogDetails")}
        </button>
      </div>
      <div
        role="log"
        aria-live="polite"
        className="max-h-52 overflow-y-auto border-t border-[var(--app-border)] px-3 py-2 text-[11px] leading-4 text-muted-foreground"
      >
        {formatted.length > 0
          ? formatted.map((entry) => (
              <div key={entry.id} className="flex items-start gap-2">
                <span
                  className="shrink-0 font-mono tabular-nums"
                  style={{ color: "var(--app-text-tertiary)" }}
                >
                  {entry.time}
                </span>
                <div className="min-w-0 flex-1">
                  <div
                    className="break-words whitespace-pre-wrap"
                    style={{ color: restoreLogToneColor(entry.tone) }}
                  >
                    {entry.text}
                  </div>
                  {showRaw ? (
                    <div
                      className="break-all whitespace-pre-wrap font-mono"
                      style={{ color: "var(--app-text-tertiary)" }}
                    >
                      {entry.raw}
                    </div>
                  ) : null}
                </div>
              </div>
            ))
          : t("restoreLogPending")}
      </div>
    </div>
  );
}

function LaunchErrorPanel({
  error,
  onRetry,
  onRemove,
}: {
  error: TerminalLaunchError;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("panes");
  const message = translateError(error);
  return (
    <div className="flex h-full w-full items-center justify-center bg-background/95 px-6 py-8">
      <div className="flex w-full max-w-xl flex-col items-center text-center">
        <CircleAlert className="mb-4 h-9 w-9 text-destructive" aria-hidden="true" />
        <h3 className="text-base font-semibold text-foreground">{t("terminalLaunchFailed")}</h3>
        <p className="mt-2 max-w-full break-words text-sm leading-6 text-muted-foreground">
          {message}
        </p>
        {error.params?.path ? (
          <code className="mt-2 max-w-full break-all text-xs text-muted-foreground">
            {error.params.path}
          </code>
        ) : null}
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Button size="sm" onClick={onRetry}>
            <RotateCcw className="h-4 w-4" />
            {t("retryTerminalLaunch")}
          </Button>
          <Button size="sm" variant="outline" onClick={onRemove}>
            <X className="h-4 w-4" />
            {t("removeFailedTerminal")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default memo(function TerminalTabContent({
  tab,
  isVisible,
  isActive,
  layoutActive,
  onSessionCreated,
  onSessionExited,
  onTerminalRef,
  onReconnect,
}: TerminalTabContentProps) {
  const { t } = useTranslation("panes");
  const setActiveTerminalPane = usePanesStore((s) => s.setActiveTerminalPane);
  const resizeTerminalPanes = usePanesStore((s) => s.resizeTerminalPanes);
  const setTerminalLaunchError = usePanesStore((s) => s.setTerminalLaunchError);
  const retryTerminalLaunch = usePanesStore((s) => s.retryTerminalLaunch);
  const removeTerminalLaunch = usePanesStore((s) => s.removeTerminalLaunch);
  const restoreLogs = useTerminalRestoreLogStore((s) => s.logs);
  const hasProjectPath = Boolean(tab.projectPath);

  const renderNode = useCallback((node: TerminalPaneNode): ReactNode => {
    if (node.type === "leaf") {
      const leaf = node;
      const preflightError = !leaf.sessionId && hasProjectPath
        ? classifyTerminalLaunchPath({
            path: tab.projectPath,
            workspacePath: leaf.workspacePath,
            ssh: leaf.ssh,
            wsl: leaf.wsl,
          })
        : null;
      const launchError = leaf.launchError ?? preflightError;
      const restoreBlocked = !leaf.sessionId && leaf.restoreBlockedReason;
      const showPlaceholder = !leaf.sessionId && !leaf.restoring;
      const showRestorePlaceholder = !leaf.sessionId && !!leaf.restoring;
      const leafRestoreLogs = restoreLogs[terminalRestoreLogKey(tab.id, leaf.id)] ?? [];
      const isLaunching = showPlaceholder && hasProjectPath;
      return (
        <div
          key={leaf.id}
          className="relative h-full w-full overflow-hidden"
          onMouseDown={() => setActiveTerminalPane(tab.id, leaf.id)}
        >
          {restoreBlocked ? (
            <div className="flex h-full w-full items-center justify-center bg-background/95 px-6 py-8">
              <div className="flex w-full max-w-3xl flex-col items-center text-center">
                <CircleAlert className="mb-4 h-9 w-9 text-[var(--app-status-warning)]" aria-hidden="true" />
                <h3 className="text-base font-semibold text-foreground">
                  {t("restoreBlockedTitle")}
                </h3>
                <p className="mt-2 max-w-full break-words text-sm leading-6 text-muted-foreground">
                  {t(`restoreBlocked.${restoreBlocked}`)}
                </p>
                <div className="mt-5 w-full text-left">
                  <RestoreLogSurface entries={leafRestoreLogs} />
                </div>
              </div>
            </div>
          ) : launchError ? (
            <LaunchErrorPanel
              error={launchError}
              onRetry={() => retryTerminalLaunch(tab.id, leaf.id)}
              onRemove={() => removeTerminalLaunch(tab.id, leaf.id)}
            />
          ) : (
            <TerminalView
              key={`${leaf.id}:${leaf.launchAttempt ?? 0}`}
              ref={(ref) => onTerminalRef(leaf.id, ref)}
              sessionId={leaf.sessionId}
              launchId={leaf.launchId}
              launchAttempt={leaf.launchAttempt}
              projectPath={tab.projectPath}
              isVisible={isVisible}
              isActive={isActive && tab.activeTerminalPaneId === leaf.id}
              layoutActive={layoutActive}
              workspaceName={leaf.workspaceName}
              providerId={leaf.providerId}
              modelId={leaf.modelId}
              providerSelection={leaf.providerSelection}
              launchProfileId={leaf.launchProfileId}
              workspacePath={leaf.workspacePath}
              workspaceSnapshotId={leaf.workspaceSnapshotId}
              launchClaude={leaf.launchClaude}
              cliTool={leaf.cliTool}
              resumeId={leaf.resumeId}
              skipMcp={leaf.launchExtras?.skipMcp}
              appendSystemPrompt={leaf.launchExtras?.appendSystemPrompt}
              initialPrompt={leaf.launchExtras?.initialPrompt}
              yoloMode={leaf.launchExtras?.yolo}
              adapterOptions={leaf.launchExtras?.adapterOptions}
              ssh={leaf.ssh}
              wsl={leaf.wsl}
              restoring={leaf.restoring}
              savedSessionId={leaf.savedSessionId}
              readOnly={leaf.leaseReadOnly}
              paneId={leaf.id}
              tabId={tab.id}
              visibilityOwnerId={tab.id}
              onLaunchError={(error) => setTerminalLaunchError(tab.id, leaf.id, error)}
              onSessionCreated={(sessionId) => onSessionCreated(sessionId, leaf.id)}
              onSessionExited={onSessionExited ? (code) => onSessionExited(code, leaf.id) : undefined}
              onReconnect={onReconnect ? () => onReconnect(leaf.id) : undefined}
            />
          )}
          {leaf.sessionId ? (
            <VoiceInputButton
              sessionId={leaf.sessionId}
              paneId={leaf.id}
              disabled={Boolean(leaf.disconnected || leaf.restoring || leaf.leaseReadOnly)}
            />
          ) : null}
          {!restoreBlocked && !launchError && showPlaceholder ? (
            <div
              className="pointer-events-none absolute left-3 top-3 z-[1] flex max-w-[calc(100%-1.5rem)] items-start"
              style={{ top: "calc(var(--notch-bar-height, 0px) + 12px)" }}
            >
              <div
                className="flex items-center gap-2 rounded-lg px-3 py-2"
                style={{
                  background: "var(--app-hover)",
                  border: "1px solid var(--app-border)",
                  boxShadow: "var(--sh-md)",
                }}
              >
                <Terminal
                  className="h-4 w-4 shrink-0"
                  style={{ color: "var(--app-text-tertiary)" }}
                />
                <div className="flex min-w-0 flex-col">
                  <span
                    className="text-xs font-medium tracking-wide"
                    style={{ color: "var(--app-text-primary)" }}
                  >
                    {isLaunching ? t("startingTerminal") : t("ready")}
                  </span>
                  <span
                    className="text-[11px] leading-4"
                    style={{ color: "var(--app-text-secondary)" }}
                  >
                    {isLaunching ? t("startingTerminalHint") : t("selectProject")}
                  </span>
                </div>
              </div>
            </div>
          ) : null}
          {!restoreBlocked && !launchError && showRestorePlaceholder ? (
            <div
              className="absolute left-3 top-3 z-[1] flex w-[calc(100%-1.5rem)] max-w-3xl items-start"
              style={{ top: "calc(var(--notch-bar-height, 0px) + 12px)" }}
            >
              <div
                className="flex w-full min-w-0 flex-col overflow-hidden rounded-lg"
                style={{
                  background: "var(--app-hover)",
                  border: "1px solid var(--app-border)",
                  boxShadow: "var(--sh-md)",
                }}
              >
                <RestoreLogSurface entries={leafRestoreLogs} />
              </div>
            </div>
          ) : null}
          {leaf.sessionId && leaf.leaseReadOnly ? (
            <div
              className="pointer-events-none absolute left-3 top-3 z-[2] flex max-w-[calc(100%-1.5rem)] items-center gap-2 rounded px-2.5 py-1.5 text-xs"
              style={{
                top: "calc(var(--notch-bar-height, 0px) + 12px)",
                color: "var(--app-status-warning)",
                background: "var(--app-status-warning-bg)",
                border: "1px solid var(--app-status-warning)",
              }}
            >
              <LockKeyhole className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 break-words">{t("terminalLeaseReadOnly")}</span>
            </div>
          ) : null}
        </div>
      );
    }

    const childKeys = node.children.map((child) => child.id);
    return (
      <div key={node.id} className="h-full w-full min-h-0 min-w-0">
        <SplitView
          vertical={node.direction === "vertical"}
          sizes={node.sizes}
          minSize={50}
          onDragEnd={(sizes) => resizeTerminalPanes(tab.id, node.id, normalizeSizes(sizes))}
          keys={childKeys}
        >
          {node.children.map((child) => renderNode(child))}
        </SplitView>
      </div>
    );
  }, [
    isActive,
    isVisible,
    layoutActive,
    hasProjectPath,
    onReconnect,
    onSessionCreated,
    onSessionExited,
    onTerminalRef,
    resizeTerminalPanes,
    removeTerminalLaunch,
    retryTerminalLaunch,
    setTerminalLaunchError,
    setActiveTerminalPane,
    restoreLogs,
    tab.activeTerminalPaneId,
    tab.id,
    tab.projectPath,
    t,
  ]);

  if (!tab.terminalRootPane) return null;
  return (
    <div
      className="relative h-full w-full min-h-0 min-w-0 overflow-hidden"
      style={{
        boxShadow: "inset 0 1px 0 var(--app-border)",
        ["--splitview-line-inset-top" as string]: "calc(var(--notch-bar-height, 0px) + 10px)",
        ["--splitview-line-inset-bottom" as string]: "10px",
        ["--splitview-line-inset-left" as string]: "10px",
        ["--splitview-line-inset-right" as string]: "10px",
      }}
    >
      <div
        className="pointer-events-none absolute left-0 right-0 z-[1]"
        style={{
          top: "var(--notch-bar-height, 0px)",
          height: "1px",
          background: "var(--app-border)",
        }}
      />
      {renderNode(tab.terminalRootPane)}
    </div>
  );
});

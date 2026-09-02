import { isInteractivePhase, phaseOf } from "@/lib/terminalRuntimePhase";
import { memo, useCallback, useState, type ReactNode } from "react";
import { LockKeyhole, MessageSquareText, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Tab, TerminalPaneNode } from "@/types";
import { isTranscriptSupportedCliTool } from "@/types/agentTranscript";
import {
  terminalRestoreLogKey,
  usePanesStore,
  useSettingsStore,
  useTerminalRestoreLogStore,
  useOrchestratorStore,
} from "@/stores";
import { useTabViewStateStore, viewKey } from "@/stores/useTabViewStateStore";
import type { ActiveTerminalContext } from "@/hooks/useActiveTerminalSession";
import { classifyTerminalLaunchPath } from "@/utils";
import AgentChatView, { type TerminalViewMode } from "./AgentChatView";
import SplitView from "./SplitView";
import { BlockedRestorePanel, LaunchErrorPanel, RestoreLogSurface } from "./TerminalLeafPanels";
import TerminalView from "./TerminalView";
import type { TerminalViewHandle } from "./TerminalView";
import TerminalStatusBar from "./TerminalStatusBar";
import VoiceInputButton from "./VoiceInputButton";

interface TerminalTabContentProps {
  tab: Tab;
  layoutActive: boolean;
  showStatusBar?: boolean;
  /** 所属窗格（Panel）id，透传给状态条做焦点渐进展示 */
  paneId?: string;
  onSessionCreated: (sessionId: string, terminalPaneId?: string) => void;
  onSessionExited?: (exitCode: number, terminalPaneId?: string) => void;
  onTerminalRef: (terminalPaneId: string, ref: TerminalViewHandle | null) => void;
  onReconnect?: (terminalPaneId: string) => Promise<string | null>;
}

function terminalContextForLeaf(tab: Tab, leaf: Extract<TerminalPaneNode, { type: "leaf" }>): ActiveTerminalContext {
  return {
    sessionId: leaf.sessionId,
    cliTool: (leaf.cliTool ?? tab.cliTool)?.toLowerCase() ?? null,
    ssh: Boolean(leaf.ssh ?? tab.ssh),
    providerId: (leaf.providerId ?? tab.providerId)?.trim() || null,
    modelId: (leaf.modelId ?? tab.modelId)?.trim() || null,
    providerSelection: leaf.providerSelection ?? tab.providerSelection ?? null,
    launchProfileId: (leaf.launchProfileId ?? tab.launchProfileId)?.trim() || null,
  };
}

function normalizeSizes(sizes: number[]): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= 0 || sizes.length === 0) return sizes;
  const rounded = sizes.map((size) => Math.round((size / total) * 1000) / 10);
  const sum = rounded.slice(0, -1).reduce((acc, size) => acc + size, 0);
  rounded[rounded.length - 1] = Math.round((100 - sum) * 10) / 10;
  return rounded;
}

export default memo(function TerminalTabContent({
  tab,
  layoutActive,
  showStatusBar = false,
  paneId,
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
  const bindings = useOrchestratorStore((s) => s.bindings);
  // 状态栏门控读单视图（primary 写侧已把 tab/layout 两层可见性都编码进去）
  const primaryViewVisible = useTabViewStateStore((s) => {
    const v = s.views[viewKey(tab.id, "primary")]?.visibility;
    return v !== undefined && v !== "hidden";
  });
  // 设置里关掉状态栏时，状态栏上的 Terminal|Chat 切换会消失，需要浮动入口兜底。
  const settingsShowStatusBar = useSettingsStore(
    (s) => s.settings?.terminal.showStatusBar ?? true,
  );
  const hasProjectPath = Boolean(tab.projectPath);
  // per-leaf Terminal|Chat；仅 runtime，不进 layout 快照。
  const [viewModes, setViewModes] = useState<Record<string, TerminalViewMode>>({});
  const setLeafViewMode = useCallback((leafId: string, mode: TerminalViewMode) => {
    setViewModes((prev) => (prev[leafId] === mode ? prev : { ...prev, [leafId]: mode }));
  }, []);

  const renderNode = useCallback((node: TerminalPaneNode): ReactNode => {
    if (node.type === "leaf") {
      const leaf = node;
      const viewMode = viewModes[leaf.id] ?? "terminal";
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
      const leafCli = leaf.cliTool ?? tab.cliTool;
      const leafResume = leaf.resumeId ?? tab.resumeId;
      return (
        <div
          key={leaf.id}
          className="flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden"
          onMouseDown={() => setActiveTerminalPane(tab.id, leaf.id)}
        >
          <div
            data-flow-tab-id={tab.id}
            data-flow-session-id={leaf.sessionId ?? undefined}
            data-flow-leaf-id={leaf.id}
            data-flow-binding-id={bindings.find((binding) =>
              (leaf.sessionId && binding.sessionId === leaf.sessionId) ||
              binding.tabId === tab.id,
            )?.id}
            className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
          >
          {restoreBlocked ? (
            <BlockedRestorePanel
              tabId={tab.id}
              terminalPaneId={leaf.id}
              leaf={leaf}
              reason={restoreBlocked}
              entries={leafRestoreLogs}
            />
          ) : launchError ? (
            <LaunchErrorPanel
              error={launchError}
              onRetry={() => retryTerminalLaunch(tab.id, leaf.id)}
              onRemove={() => removeTerminalLaunch(tab.id, leaf.id)}
            />
          ) : (
            <>
              {/* Chat 时 hidden 保活 xterm/WS，不 unmount。 */}
              <div
                className={viewMode === "terminal" ? "h-full w-full" : "hidden h-full w-full"}
                aria-hidden={viewMode !== "terminal"}
              >
                <TerminalView
                  key={`${leaf.id}:${leaf.launchAttempt ?? 0}`}
                  ref={(ref) => onTerminalRef(leaf.id, ref)}
                  sessionId={leaf.sessionId}
                  launchId={leaf.launchId}
                  launchAttempt={leaf.launchAttempt}
                  projectPath={tab.projectPath}
                  layoutActive={layoutActive}
                  leafFocused={tab.activeTerminalPaneId === leaf.id && viewMode === "terminal"}
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
              </div>
              {viewMode === "chat" ? (
                <div className="absolute inset-0 z-[3]">
                  <AgentChatView
                    cliTool={leafCli}
                    resumeId={leafResume}
                    cwd={tab.projectPath}
                    onBackToTerminal={() => setLeafViewMode(leaf.id, "terminal")}
                  />
                </div>
              ) : null}
            </>
          )}
          {leaf.sessionId ? (
            <VoiceInputButton
              sessionId={leaf.sessionId}
              paneId={leaf.id}
              // phaseOf 首批消费方（docs/78）：可交互判定不再手工组合字段。
              // 语义增强：restore-blocked 也会禁用（旧表达式漏了这档）。
              disabled={!isInteractivePhase(phaseOf(leaf), leaf.leaseReadOnly)}
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
          {/* 状态栏被关掉时的 Chat 入口兜底（explore gotcha §8.12） */}
          {viewMode === "terminal"
            && !restoreBlocked
            && !launchError
            && isTranscriptSupportedCliTool(leafCli)
            && leafResume
            && leafResume !== "new"
            && !(showStatusBar && settingsShowStatusBar) ? (
            <button
              type="button"
              className="absolute right-3 z-[2] flex items-center gap-1 rounded-md px-2 py-1 text-[11px]"
              style={{
                top: "calc(var(--notch-bar-height, 0px) + 12px)",
                background: "var(--app-hover)",
                border: "1px solid var(--app-border)",
                color: "var(--app-text-primary)",
                boxShadow: "var(--sh-md)",
              }}
              onClick={() => setLeafViewMode(leaf.id, "chat")}
              data-testid="agent-chat-floating-open"
              title={t("chatOpenHistory")}
            >
              <MessageSquareText className="size-3.5" aria-hidden="true" />
              {t("viewModeChat")}
            </button>
          ) : null}
          </div>
          {showStatusBar ? (
            <TerminalStatusBar
              terminalContext={terminalContextForLeaf(tab, leaf)}
              projectPath={tab.projectPath}
              effort={leaf.launchExtras?.adapterOptions?.effort ?? tab.launchExtras?.adapterOptions?.effort}
              enabled={primaryViewVisible}
              paneId={paneId}
              viewMode={viewMode}
              onViewModeChange={(mode) => setLeafViewMode(leaf.id, mode)}
              resumeId={leafResume}
            />
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
    layoutActive,
    hasProjectPath,
    onReconnect,
    onSessionCreated,
    onSessionExited,
    onTerminalRef,
    paneId,
    resizeTerminalPanes,
    removeTerminalLaunch,
    retryTerminalLaunch,
    setTerminalLaunchError,
    setActiveTerminalPane,
    restoreLogs,
    bindings,
    showStatusBar,
    settingsShowStatusBar,
    viewModes,
    setLeafViewMode,
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

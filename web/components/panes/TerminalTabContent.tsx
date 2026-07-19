import { memo, useCallback, useState, type ReactNode } from "react";
import { Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Tab, TerminalPaneNode } from "@/types";
import { usePanesStore } from "@/stores";
import SplitView from "./SplitView";
import TerminalView from "./TerminalView";
import type { RestoreLaunchState } from "./terminalRestoreQueue";
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
  const hasProjectPath = Boolean(tab.projectPath);
  const [restoreLaunchStates, setRestoreLaunchStates] = useState<Record<string, RestoreLaunchState>>({});

  const updateRestoreLaunchState = useCallback((leafId: string, state: RestoreLaunchState) => {
    setRestoreLaunchStates((current) => {
      if (state === "idle") {
        if (!current[leafId]) return current;
        const next = { ...current };
        delete next[leafId];
        return next;
      }
      if (current[leafId] === state) return current;
      return { ...current, [leafId]: state };
    });
  }, []);

  const renderNode = useCallback((node: TerminalPaneNode): ReactNode => {
    if (node.type === "leaf") {
      const leaf = node;
      const showPlaceholder = !leaf.sessionId && !leaf.restoring;
      const showRestorePlaceholder = !leaf.sessionId && !!leaf.restoring;
      const restoreLaunchState = restoreLaunchStates[leaf.id];
      const isLaunching = showPlaceholder && hasProjectPath;
      const restoreTitle = restoreLaunchState === "queued"
        ? t("restoreQueued")
        : restoreLaunchState === "failed"
          ? t("restoreFailed")
          : t("restoringTerminal");
      const restoreHint = restoreLaunchState === "queued"
        ? t("restoreQueuedHint")
        : restoreLaunchState === "failed"
          ? t("restoreFailedHint")
          : t("restoringTerminalHint");
      return (
        <div
          key={leaf.id}
          className="relative h-full w-full overflow-hidden"
          onMouseDown={() => setActiveTerminalPane(tab.id, leaf.id)}
        >
          <TerminalView
            ref={(ref) => onTerminalRef(leaf.id, ref)}
            sessionId={leaf.sessionId}
            projectId={tab.projectId}
            projectPath={tab.projectPath}
            isVisible={isVisible}
            isActive={isActive && tab.activeTerminalPaneId === leaf.id}
            layoutActive={layoutActive}
            workspaceName={leaf.workspaceName}
            providerId={leaf.providerId}
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
            paneId={leaf.id}
            tabId={tab.id}
            onRestoreLaunchState={(state) => updateRestoreLaunchState(leaf.id, state)}
            onSessionCreated={(sessionId) => onSessionCreated(sessionId, leaf.id)}
            onSessionExited={onSessionExited ? (code) => onSessionExited(code, leaf.id) : undefined}
            onReconnect={onReconnect ? () => onReconnect(leaf.id) : undefined}
          />
          {leaf.sessionId ? (
            <VoiceInputButton
              sessionId={leaf.sessionId}
              paneId={leaf.id}
              disabled={Boolean(leaf.disconnected || leaf.restoring)}
            />
          ) : null}
          {showPlaceholder ? (
            <div
              className="pointer-events-none absolute left-3 top-3 z-[1] flex max-w-[calc(100%-1.5rem)] items-start"
              style={{ top: "calc(var(--notch-bar-height, 0px) + 12px)" }}
            >
              <div
                className="flex items-center gap-2 rounded-lg px-3 py-2"
                style={{
                  background: "rgba(255,255,255,0.05)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  boxShadow: "0 8px 24px rgba(0,0,0,0.22)",
                }}
              >
                <Terminal
                  className="h-4 w-4 shrink-0"
                  style={{ color: "rgba(255,255,255,0.42)" }}
                />
                <div className="flex min-w-0 flex-col">
                  <span
                    className="text-xs font-medium tracking-wide"
                    style={{ color: "rgba(255,255,255,0.84)" }}
                  >
                    {isLaunching ? t("startingTerminal") : t("ready")}
                  </span>
                  <span
                    className="text-[11px] leading-4"
                    style={{ color: "rgba(255,255,255,0.45)" }}
                  >
                    {isLaunching ? t("startingTerminalHint") : t("selectProject")}
                  </span>
                </div>
              </div>
            </div>
          ) : null}
          {showRestorePlaceholder ? (
            <div
              className="pointer-events-none absolute left-3 top-3 z-[1] flex max-w-[calc(100%-1.5rem)] items-start"
              style={{ top: "calc(var(--notch-bar-height, 0px) + 12px)" }}
            >
              <div
                className="flex items-center gap-2 rounded-lg px-3 py-2"
                style={{
                  background: "rgba(255,255,255,0.05)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  boxShadow: "0 8px 24px rgba(0,0,0,0.22)",
                }}
              >
                <Terminal
                  className="h-4 w-4 shrink-0"
                  style={{ color: "rgba(255,255,255,0.42)" }}
                />
                <div className="flex min-w-0 flex-col">
                  <span
                    className="text-xs font-medium tracking-wide"
                    style={{ color: "rgba(255,255,255,0.84)" }}
                  >
                    {restoreTitle}
                  </span>
                  <span
                    className="text-[11px] leading-4"
                    style={{ color: "rgba(255,255,255,0.45)" }}
                  >
                    {restoreHint}
                  </span>
                </div>
              </div>
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
    setActiveTerminalPane,
    restoreLaunchStates,
    tab.activeTerminalPaneId,
    tab.id,
    tab.projectPath,
    t,
    updateRestoreLaunchState,
  ]);

  if (!tab.terminalRootPane) return null;
  return (
    <div
      className="relative h-full w-full min-h-0 min-w-0 overflow-hidden"
      style={{
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
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
          background: "rgba(255,255,255,0.08)",
        }}
      />
      {renderNode(tab.terminalRootPane)}
    </div>
  );
});

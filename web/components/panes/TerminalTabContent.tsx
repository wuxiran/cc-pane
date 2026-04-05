import { memo, useCallback, type ReactNode } from "react";
import type { Tab, TerminalPaneNode } from "@/types";
import { usePanesStore } from "@/stores";
import SplitView from "./SplitView";
import TerminalView from "./TerminalView";
import type { TerminalViewHandle } from "./TerminalView";

interface TerminalTabContentProps {
  tab: Tab;
  isActive: boolean;
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
  isActive,
  onSessionCreated,
  onSessionExited,
  onTerminalRef,
  onReconnect,
}: TerminalTabContentProps) {
  const setActiveTerminalPane = usePanesStore((s) => s.setActiveTerminalPane);
  const resizeTerminalPanes = usePanesStore((s) => s.resizeTerminalPanes);

  const renderNode = useCallback((node: TerminalPaneNode): ReactNode => {
    if (node.type === "leaf") {
      const leaf = node;
      return (
        <div
          key={leaf.id}
          className="h-full w-full overflow-hidden"
          onMouseDown={() => setActiveTerminalPane(tab.id, leaf.id)}
        >
          <TerminalView
            ref={(ref) => onTerminalRef(leaf.id, ref)}
            sessionId={leaf.sessionId}
            projectPath={tab.projectPath}
            isActive={isActive && tab.activeTerminalPaneId === leaf.id}
            workspaceName={leaf.workspaceName}
            providerId={leaf.providerId}
            workspacePath={leaf.workspacePath}
            launchClaude={leaf.launchClaude}
            cliTool={leaf.cliTool}
            resumeId={leaf.resumeId}
            ssh={leaf.ssh}
            wsl={leaf.wsl}
            restoring={leaf.restoring}
            savedSessionId={leaf.savedSessionId}
            paneId={leaf.id}
            tabId={tab.id}
            onSessionCreated={(sessionId) => onSessionCreated(sessionId, leaf.id)}
            onSessionExited={onSessionExited ? (code) => onSessionExited(code, leaf.id) : undefined}
            onReconnect={onReconnect ? () => onReconnect(leaf.id) : undefined}
          />
        </div>
      );
    }

    const childKeys = node.children.map((child) => child.id);
    return (
      <div key={node.id} className="h-full">
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
    onReconnect,
    onSessionCreated,
    onSessionExited,
    onTerminalRef,
    resizeTerminalPanes,
    setActiveTerminalPane,
    tab.activeTerminalPaneId,
    tab.id,
    tab.projectPath,
  ]);

  if (!tab.terminalRootPane) return null;
  return <div className="h-full">{renderNode(tab.terminalRootPane)}</div>;
});

import { EyeOff, FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import ContextUsageIndicator from "@/components/ContextUsageIndicator";
import StatusIndicator from "@/components/StatusIndicator";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { ActiveTerminalContext } from "@/hooks/useActiveTerminalSession";
import { useSettingsStore, useTerminalStatusStore } from "@/stores";
import type { LaunchEffort } from "@/types";

interface TerminalStatusBarProps {
  terminalContext: ActiveTerminalContext;
  projectPath: string;
  effort?: LaunchEffort;
  enabled?: boolean;
}

function compactProjectPath(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) return path;
  return `.../${parts.slice(-2).join("/")}`;
}

export default function TerminalStatusBar({
  terminalContext,
  projectPath,
  effort,
  enabled = true,
}: TerminalStatusBarProps) {
  const { t } = useTranslation("panes");
  const statusInfo = useTerminalStatusStore((state) => (
    terminalContext.sessionId
      ? state.statusMap.get(terminalContext.sessionId)
      : undefined
  ));
  const showContextUsage = useSettingsStore(
    (state) => state.settings?.terminal.showContextUsage ?? true,
  );
  const showStatusBar = useSettingsStore(
    (state) => state.settings?.terminal.showStatusBar ?? true,
  );
  const saveSettings = useSettingsStore((state) => state.saveSettings);
  const handleToggleStatusBar = () => {
    const current = useSettingsStore.getState().settings;
    if (!current) return;
    void saveSettings({
      ...current,
      terminal: { ...current.terminal, showStatusBar: !showStatusBar },
    });
  };

  if (!showStatusBar) {
    // 关掉时整段不渲染：没有空条占位，终端区直接吃掉这段高度。
    return null;
  }
  const cliLabel = terminalContext.cliTool && terminalContext.cliTool !== "none"
    ? terminalContext.cliTool
    : null;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-testid="terminal-status-bar"
          className="flex h-7 min-w-0 shrink-0 select-none items-center gap-2 border-t px-2 text-[10px]"
          style={{
            background: "var(--app-menubar)",
            borderColor: "var(--app-border)",
            color: "var(--app-text-secondary)",
          }}
        >
          <StatusIndicator
            status={statusInfo?.status ?? null}
            toolName={statusInfo?.currentToolName}
            size={7}
          />
          {cliLabel ? (
            <span className="shrink-0 font-medium" style={{ color: "var(--app-text-primary)" }}>
              {cliLabel}
            </span>
          ) : null}
          {terminalContext.modelId ? (
            <span className="max-w-28 shrink truncate" title={terminalContext.modelId}>
              {terminalContext.modelId}
            </span>
          ) : null}
          {effort ? (
            <span className="shrink-0" style={{ color: "var(--app-status-warning)" }}>
              {effort}
            </span>
          ) : null}
          {showContextUsage && (
            <ContextUsageIndicator terminalContext={terminalContext} enabled={enabled} />
          )}
          <span className="min-w-0 flex-1" />
          <span
            className="flex min-w-0 max-w-[42%] items-center gap-1"
            title={projectPath}
          >
            <FolderOpen className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{compactProjectPath(projectPath)}</span>
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onSelect={handleToggleStatusBar}>
          <EyeOff /> {t("statusBarHide")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

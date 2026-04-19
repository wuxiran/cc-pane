import WorkspaceTree from "@/components/sidebar/WorkspaceTree";
import type { OpenTerminalOptions } from "@/types";

interface ExplorerViewProps {
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
}

export default function ExplorerView({ onOpenTerminal }: ExplorerViewProps) {
  return (
    <div className="flex h-full flex-col">
      {/* 视图标题栏 */}
      <div className="shrink-0 px-4 py-2">
        <span
          className="text-[11px] font-bold tracking-wider"
          style={{ color: "var(--app-text-secondary)" }}
        >
          EXPLORER
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        <WorkspaceTree onOpenTerminal={onOpenTerminal} />
      </div>
    </div>
  );
}

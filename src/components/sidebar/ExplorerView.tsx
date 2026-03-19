import WorkspaceTree from "@/components/sidebar/WorkspaceTree";
import type { OpenTerminalOptions } from "@/types";

interface ExplorerViewProps {
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
}

export default function ExplorerView({ onOpenTerminal }: ExplorerViewProps) {
  return (
    <div className="flex flex-col h-full">
      {/* 视图标题栏 */}
      <div className="flex items-center px-4 py-2 shrink-0">
        <span
          className="text-[11px] font-bold tracking-wider"
          style={{ color: "var(--app-text-secondary)" }}
        >
          EXPLORER
        </span>
      </div>

      {/* WorkspaceTree */}
      <div className="flex-1 overflow-y-auto px-3 pb-2">
        <WorkspaceTree onOpenTerminal={onOpenTerminal} />
      </div>
    </div>
  );
}

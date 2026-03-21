import { useEffect, useState, useMemo } from "react";
import {
  RefreshCw, Trash2, ChevronDown, ChevronRight,
  X, Cpu, AlertTriangle,
} from "lucide-react";
import { useProcessMonitorStore } from "@/stores";
import { formatSize } from "@/utils";
import type { ClaudeProcess, ClaudeProcessType } from "@/types";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** 进程类型标签颜色映射 */
const TYPE_LABELS: Record<ClaudeProcessType, { label: string; color: string }> = {
  claude_cli: { label: "CLI", color: "text-blue-400" },
  claude_node: { label: "Node", color: "text-yellow-400" },
  mcp_server: { label: "MCP", color: "text-purple-400" },
  other: { label: "Other", color: "text-slate-400" },
};

/** 格式化运行时长 */
function formatUptime(startTime: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - startTime);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
  return `${Math.floor(diff / 86400)}d ${Math.floor((diff % 86400) / 3600)}h`;
}

/** 按 cwd 分组进程 */
function groupByCwd(processes: ClaudeProcess[]): Map<string, ClaudeProcess[]> {
  const groups = new Map<string, ClaudeProcess[]>();
  for (const p of processes) {
    const key = p.cwd || "(unknown)";
    const list = groups.get(key) || [];
    list.push(p);
    groups.set(key, list);
  }
  return groups;
}

/** 从路径中提取文件夹名 */
function getFolderName(path: string): string {
  if (path === "(unknown)") return path;
  const sep = path.includes("\\") ? "\\" : "/";
  const parts = path.split(sep).filter(Boolean);
  return parts[parts.length - 1] || path;
}

/** 单个进程项 */
function ProcessItem({
  process,
  selected,
  killing,
  onToggle,
  onKill,
}: {
  process: ClaudeProcess;
  selected: boolean;
  killing: boolean;
  onToggle: () => void;
  onKill: () => void;
}) {
  const typeInfo = TYPE_LABELS[process.processType];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="group flex items-center gap-1.5 px-2 py-1 rounded hover:bg-[var(--app-hover)] transition-colors text-[11px]">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            className="w-3 h-3 shrink-0 accent-[var(--app-accent)] cursor-pointer"
          />
          <span className="truncate text-[var(--app-text-secondary)] flex-1 min-w-0">
            {process.name}
          </span>
          <span className={`shrink-0 text-[10px] font-mono ${typeInfo.color}`}>
            {typeInfo.label}
          </span>
          <span className="shrink-0 text-[10px] text-[var(--app-text-tertiary)] font-mono w-[40px] text-right">
            {formatSize(process.memoryBytes)}
          </span>
          <span className="shrink-0 text-[10px] text-[var(--app-text-tertiary)] font-mono w-[32px] text-right">
            {formatUptime(process.startTime)}
          </span>
          <button
            onClick={(e) => { e.stopPropagation(); onKill(); }}
            disabled={killing}
            className="shrink-0 opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-500/20 text-[var(--app-text-tertiary)] hover:text-red-400 transition-all disabled:opacity-50"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-[400px]">
        <div className="text-[11px] space-y-1">
          <div><strong>PID:</strong> {process.pid}</div>
          <div><strong>Command:</strong> <span className="break-all">{process.command || "(empty)"}</span></div>
          {process.cwd && <div><strong>CWD:</strong> {process.cwd}</div>}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/** CWD 分组折叠区 */
function CwdGroup({
  cwdPath,
  processes,
  selectedPids,
  killing,
  onToggle,
  onKill,
}: {
  cwdPath: string;
  processes: ClaudeProcess[];
  selectedPids: Set<number>;
  killing: Set<number>;
  onToggle: (pid: number) => void;
  onKill: (pid: number) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const groupMemory = processes.reduce((sum, p) => sum + p.memoryBytes, 0);

  return (
    <div>
      <button
        className="flex items-center gap-1 w-full px-2 py-1 text-[11px] font-medium text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)] rounded transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded
          ? <ChevronDown className="w-3 h-3 shrink-0" />
          : <ChevronRight className="w-3 h-3 shrink-0" />
        }
        <span className="truncate flex-1 text-left">{getFolderName(cwdPath)}</span>
        <span className="shrink-0 text-[10px] text-[var(--app-text-tertiary)]">
          {processes.length} · {formatSize(groupMemory)}
        </span>
      </button>
      {expanded && (
        <div className="pl-2">
          {processes.map((p) => (
            <ProcessItem
              key={p.pid}
              process={p}
              selected={selectedPids.has(p.pid)}
              killing={killing.has(p.pid)}
              onToggle={() => onToggle(p.pid)}
              onKill={() => onKill(p.pid)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function ProcessMonitorSection() {
  const scanResult = useProcessMonitorStore((s) => s.scanResult);
  const scanning = useProcessMonitorStore((s) => s.scanning);
  const killing = useProcessMonitorStore((s) => s.killing);
  const selectedPids = useProcessMonitorStore((s) => s.selectedPids);
  const scan = useProcessMonitorStore((s) => s.scan);
  const killProcess = useProcessMonitorStore((s) => s.killProcess);
  const killSelected = useProcessMonitorStore((s) => s.killSelected);
  const killAll = useProcessMonitorStore((s) => s.killAll);
  const toggleSelect = useProcessMonitorStore((s) => s.toggleSelect);
  const startAutoRefresh = useProcessMonitorStore((s) => s.startAutoRefresh);
  const stopAutoRefresh = useProcessMonitorStore((s) => s.stopAutoRefresh);

  const [expanded, setExpanded] = useState(true);
  const [confirmAction, setConfirmAction] = useState<"selected" | "all" | null>(null);

  // 挂载时启动自动刷新，卸载时停止
  useEffect(() => {
    startAutoRefresh();
    return () => stopAutoRefresh();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- Zustand store 函数引用稳定
  }, []);

  // Escape 键关闭确认弹窗
  useEffect(() => {
    if (!confirmAction) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmAction(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [confirmAction]);

  const groups = useMemo(() => {
    if (!scanResult) return new Map<string, ClaudeProcess[]>();
    return groupByCwd(scanResult.processes);
  }, [scanResult]);

  const totalCount = scanResult?.totalCount ?? 0;
  const totalMemory = scanResult?.totalMemoryBytes ?? 0;

  const handleConfirmKill = async () => {
    if (confirmAction === "selected") {
      await killSelected();
    } else if (confirmAction === "all") {
      await killAll();
    }
    setConfirmAction(null);
  };

  return (
    <div className="px-3 mb-3">
      {/* 区域标题 */}
      <div className="flex items-center gap-1">
        <button
          className="flex items-center gap-1 flex-1 min-w-0"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded
            ? <ChevronDown className="w-3 h-3 shrink-0 text-[var(--app-text-tertiary)]" />
            : <ChevronRight className="w-3 h-3 shrink-0 text-[var(--app-text-tertiary)]" />
          }
          <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--app-text-tertiary)]">
            System Processes
          </span>
          {totalCount > 0 && (
            <span className="text-[10px] text-[var(--app-text-tertiary)]">
              ({totalCount} · {formatSize(totalMemory)})
            </span>
          )}
        </button>
        <div className="flex items-center gap-0.5 shrink-0">
          {selectedPids.size > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setConfirmAction("selected")}
                  className="p-1 rounded hover:bg-red-500/20 text-[var(--app-text-tertiary)] hover:text-red-400 transition-colors"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>终止选中 ({selectedPids.size})</p>
              </TooltipContent>
            </Tooltip>
          )}
          {totalCount > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setConfirmAction("all")}
                  className="p-1 rounded hover:bg-red-500/20 text-[var(--app-text-tertiary)] hover:text-red-400 transition-colors"
                >
                  <AlertTriangle className="w-3 h-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>终止全部 ({totalCount})</p>
              </TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => scan()}
                disabled={scanning}
                className="p-1 rounded hover:bg-[var(--app-hover)] text-[var(--app-text-tertiary)] hover:text-[var(--app-text-secondary)] transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`w-3 h-3 ${scanning ? "animate-spin" : ""}`} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>刷新</p>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* 确认弹窗 */}
      {confirmAction && (
        <div className="mt-1 p-2 rounded-lg border border-red-500/30 bg-red-500/10 text-[11px]">
          <div className="flex items-center gap-1 text-red-400 mb-1.5">
            <AlertTriangle className="w-3 h-3" />
            <span className="font-medium">
              确定终止 {confirmAction === "selected" ? selectedPids.size : totalCount} 个进程？
            </span>
          </div>
          <div className="text-[var(--app-text-tertiary)] mb-2">
            总内存: {formatSize(confirmAction === "selected"
              ? (scanResult?.processes ?? [])
                  .filter((p) => selectedPids.has(p.pid))
                  .reduce((sum, p) => sum + p.memoryBytes, 0)
              : totalMemory
            )}
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={handleConfirmKill}
              className="px-2 py-0.5 rounded bg-red-500/80 text-white text-[10px] hover:bg-red-500 transition-colors"
            >
              确认
            </button>
            <button
              onClick={() => setConfirmAction(null)}
              className="px-2 py-0.5 rounded bg-[var(--app-hover)] text-[var(--app-text-secondary)] text-[10px] hover:bg-[var(--app-active)] transition-colors"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* 进程列表 */}
      {expanded && (
        <div className="mt-1">
          {totalCount === 0 && !scanning && (
            <div className="flex items-center gap-1.5 px-2 py-2 text-[11px] text-[var(--app-text-tertiary)]">
              <Cpu className="w-3 h-3" />
              <span>未发现 Claude 进程</span>
            </div>
          )}
          {totalCount === 0 && scanning && (
            <div className="flex items-center gap-1.5 px-2 py-2 text-[11px] text-[var(--app-text-tertiary)]">
              <RefreshCw className="w-3 h-3 animate-spin" />
              <span>扫描中…</span>
            </div>
          )}
          {[...groups.entries()].map(([cwdPath, processes]) => (
            <CwdGroup
              key={cwdPath}
              cwdPath={cwdPath}
              processes={processes}
              selectedPids={selectedPids}
              killing={killing}
              onToggle={toggleSelect}
              onKill={killProcess}
            />
          ))}
        </div>
      )}
    </div>
  );
}

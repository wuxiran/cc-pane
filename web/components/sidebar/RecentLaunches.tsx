import { useState, useMemo, useRef, useLayoutEffect } from "react";
import { Trash2, Play, ChevronDown, ChevronRight, Info, X, History } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatRelativeTime, buildLaunchRecordTerminalOptions } from "@/utils";
import { groupByWorkspace, type WorkspaceGroup } from "@/utils/groupLaunches";
import ResumeDetailPopover from "@/components/sidebar/ResumeDetailPopover";
import type { LaunchRecord } from "@/services";
import { useSshMachinesStore, useWorkspacesStore } from "@/stores";
import type { OpenTerminalOptions } from "@/types";

interface RecentLaunchesProps {
  launchHistory: LaunchRecord[];
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
  onClearHistory: () => void;
  onDeleteRecord: (id: number) => void;
  /** 外层滚动容器元素（SessionsView 滚动区，callback ref + state 交接），虚拟化以它为视口 */
  scrollElement: HTMLDivElement | null;
}

/** 扁平化后的虚拟行：组标题或会话行 */
type LaunchRow =
  | { type: "header"; key: string; group: WorkspaceGroup; isCollapsed: boolean }
  | { type: "record"; key: string; record: LaunchRecord; lastInGroup: boolean };

/** 近似行高，实际由 measureElement 校正（会话行带 prompt 时更高） */
const HEADER_ROW_HEIGHT = 28;
const RECORD_ROW_HEIGHT = 58;

export default function RecentLaunches({ launchHistory, onOpenTerminal, onClearHistory, onDeleteRecord, scrollElement }: RecentLaunchesProps) {
  const { t } = useTranslation("sidebar");
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const machines = useSshMachinesStore((state) => state.machines);

  const ungroupedLabel = t("ungrouped");
  const groups = useMemo(() => groupByWorkspace(launchHistory, ungroupedLabel), [launchHistory, ungroupedLabel]);

  // 折叠状态：默认全部展开（collapsed 中存储已折叠的组名）
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggleGroup = (name: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const handleResume = (record: LaunchRecord) => {
    onOpenTerminal(buildLaunchRecordTerminalOptions(record, workspaces, machines));
  };

  // 分组结构拍平成行（折叠组只留标题），喂给虚拟行
  const rows = useMemo<LaunchRow[]>(() => {
    const out: LaunchRow[] = [];
    for (const group of groups) {
      const isCollapsed = collapsed.has(group.workspaceName);
      out.push({ type: "header", key: `h:${group.workspaceName}`, group, isCollapsed });
      if (!isCollapsed) {
        group.records.forEach((record, i) => {
          out.push({
            type: "record",
            key: `r:${record.id}`,
            record,
            lastInGroup: i === group.records.length - 1,
          });
        });
      }
    }
    return out;
  }, [groups, collapsed]);

  // 列表起点相对滚动容器的偏移（上方还有 Active 区），scrollMargin 对齐坐标系。
  // 用 offsetTop 链而非 getBoundingClientRect：与 scrollTop 无关，滚动时不会漂移；
  // 要求滚动容器是 offsetParent（SessionsView 的滚动区带 relative）。
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || !scrollElement) {
      if (scrollMargin !== 0) setScrollMargin(0);
      return;
    }
    let margin = 0;
    let node: HTMLElement | null = el;
    while (node && node !== scrollElement) {
      margin += node.offsetTop;
      node = node.offsetParent as HTMLElement | null;
    }
    if (node !== scrollElement) margin = 0;
    if (margin !== scrollMargin) setScrollMargin(margin);
  });

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElement,
    estimateSize: (index) => (rows[index]?.type === "header" ? HEADER_ROW_HEIGHT : RECORD_ROW_HEIGHT),
    overscan: 5,
    scrollMargin,
    getItemKey: (index) => rows[index]?.key ?? index,
  });

  // 无可恢复会话
  if (groups.length === 0) {
    return (
      <div className="px-3 py-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--app-text-tertiary)]">
            {t("recentLaunches")}
          </span>
          {launchHistory.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  aria-label={t("clearHistory")}
                  className="transition-colors p-1 rounded-md text-[var(--app-text-tertiary)] hover:bg-[var(--app-hover)] hover:text-[var(--destructive)]"
                  onClick={onClearHistory}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{t("clearHistory")}</TooltipContent>
            </Tooltip>
          )}
        </div>
        <EmptyState icon={History} title={t("noResumableSessions")} illustration="empty-history" className="px-2 py-6" />
      </div>
    );
  }

  return (
    <>
      {/* 标题行 */}
      <div className="flex items-center justify-between px-3 py-3 mt-4 mb-1">
        <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--app-text-tertiary)]">
          {t("recentLaunches")}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label={t("clearHistory")}
              className="transition-colors p-1 rounded-md text-[var(--app-text-tertiary)] hover:bg-[var(--app-hover)] hover:text-[var(--destructive)]"
              onClick={onClearHistory}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t("clearHistory")}</TooltipContent>
        </Tooltip>
      </div>

      {/* 工作空间分组（虚拟行：只渲染可视窗口，占位高度撑出滚动范围） */}
      <div
        ref={listRef}
        style={{
          height: rowVirtualizer.getTotalSize(),
          position: "relative",
        }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (!row) return null;
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={rowVirtualizer.measureElement}
              className={row.type === "record" ? (row.lastInGroup ? "pb-1" : "pb-0.5") : undefined}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start - rowVirtualizer.options.scrollMargin}px)`,
              }}
            >
              {row.type === "header" ? (
                <button
                  className="w-full flex items-center gap-[calc(var(--density-gap)-2px)] px-3 py-[var(--density-pad-y)] rounded-lg transition-colors text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
                  onClick={() => toggleGroup(row.group.workspaceName)}
                >
                  {row.isCollapsed ? (
                    <ChevronRight className="w-3 h-3 shrink-0" />
                  ) : (
                    <ChevronDown className="w-3 h-3 shrink-0" />
                  )}
                  <span className="text-[11px] font-semibold truncate">{row.group.workspaceName}</span>
                  <span
                    className="text-[9px] ml-auto shrink-0 px-1.5 py-0.5 rounded-full text-[var(--app-text-tertiary)]"
                    style={{ background: "var(--app-hover)" }}
                  >
                    {row.group.records.length}
                  </span>
                </button>
              ) : (
                <div
                  role="button"
                  tabIndex={0}
                  className="w-full group flex items-center justify-between px-3 pl-7 py-[calc(var(--density-pad-y)+2px)] rounded-xl transition-colors duration-[var(--dur-fast)] border border-transparent cursor-pointer text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
                  onClick={() => {
                    if (!row.record.resumeSessionId) return;
                    handleResume(row.record);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      if (!row.record.resumeSessionId) return;
                      handleResume(row.record);
                    }
                  }}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Play className="w-3.5 h-3.5 text-[var(--app-status-success)] shrink-0" />
                    <div className="min-w-0 text-left">
                      <span className="text-[12px] font-medium tracking-wide truncate block max-w-[120px]">
                        {row.record.projectName}
                      </span>
                      <span className="text-[9px] font-mono truncate block max-w-[140px] text-[var(--app-text-tertiary)]">
                        {row.record.resumeSessionId?.slice(0, 8)}…
                      </span>
                      {row.record.lastPrompt && (
                        <span className="text-[10px] truncate block max-w-[120px] text-[var(--app-text-tertiary)]">
                          {row.record.lastPrompt.slice(0, 40)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-[10px] text-[var(--app-text-tertiary)]">
                      {formatRelativeTime(row.record.launchedAt)}
                    </span>
                    <ResumeDetailPopover record={row.record} onResume={handleResume} onDelete={onDeleteRecord}>
                      <button
                        aria-label={t("recordDetails")}
                        className="p-0.5 rounded opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] text-[var(--app-text-tertiary)]"
                      >
                        <Info className="w-3.5 h-3.5" />
                      </button>
                    </ResumeDetailPopover>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          aria-label={t("deleteRecord")}
                          className="p-0.5 rounded opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] text-[var(--destructive)]"
                          onClick={(e) => { e.stopPropagation(); onDeleteRecord(row.record.id); }}
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>{t("deleteRecord")}</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

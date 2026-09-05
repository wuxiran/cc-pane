import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Clock, Tag, GitBranch, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import type { FileVersion, HistoryLabel } from "@/services";
import { formatRelativeTime, formatFullTime, formatSize } from "@/utils";
import { getLabelColor } from "./useLocalHistoryData";

interface VersionListSidebarProps {
  loading: boolean;
  filteredVersions: FileVersion[];
  selectedVersion: FileVersion | null;
  fileBranches: string[];
  selectVersion: (version: FileVersion) => void;
  openLabelDialog: (version: FileVersion) => void;
  /** 恢复指定版本（右键菜单）；与底部按钮同一条 restoreVersion 路径 */
  restoreVersion: (version: FileVersion) => void;
  getVersionLabels: (versionId: string) => HistoryLabel[];
}

/** 版本行近似高度（无标签时 ~56px），实际由 measureElement 校正（标签行更高） */
const ESTIMATED_ROW_HEIGHT = 56;

export default function VersionListSidebar({
  loading,
  filteredVersions,
  selectedVersion,
  fileBranches,
  selectVersion,
  openLabelDialog,
  restoreVersion,
  getVersionLabels,
}: VersionListSidebarProps) {
  const { t } = useTranslation(["dialogs", "common"]);
  const showSkeleton = useDelayedLoading(loading);

  // 版本列表虚拟化：长历史只渲染可视行；滚动容器即侧栏本身
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: filteredVersions.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 5,
    getItemKey: (index) => filteredVersions[index]?.id ?? index,
  });

  return (
    <div ref={scrollRef} className="app-scrollbar w-[260px] shrink-0 overflow-y-auto rounded-lg p-2" style={{ border: "1px solid var(--app-border)" }}>
      {loading ? (
        showSkeleton ? (
        <div className="space-y-1" aria-busy="true" aria-live="polite">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="px-3 py-2.5">
              <div className="flex items-center gap-1.5">
                <Skeleton className="h-3 w-3 rounded-full" />
                <Skeleton className="h-3.5 w-24" />
              </div>
              <Skeleton className="mt-2 ml-[18px] h-3 w-16" />
            </div>
          ))}
        </div>
        ) : null
      ) : filteredVersions.length === 0 ? (
        <EmptyState icon={Clock} title={t("noHistory")} illustration="empty-history" className="px-2 py-8" />
      ) : (
        <div
          style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const version = filteredVersions[virtualRow.index];
            if (!version) return null;
            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={rowVirtualizer.measureElement}
                className="pb-1"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {/* 右键是菜单而非直接弹打标框：打标/恢复两个版本动作的一等入口 */}
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <div
                      role="button"
                      tabIndex={0}
                      className="px-3 py-2.5 rounded-md cursor-pointer transition-colors duration-[var(--dur-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
                      style={{
                        background: selectedVersion?.id === version.id ? "var(--app-active-bg)" : undefined,
                        borderLeft: selectedVersion?.id === version.id ? "3px solid var(--app-accent)" : "3px solid transparent",
                      }}
                      onClick={() => selectVersion(version)}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          selectVersion(version);
                        }
                      }}
                    >
                  <div className="flex items-center gap-1.5 text-[13px]" style={{ color: "var(--app-text-primary)" }}>
                    <Clock size={12} />
                    <span title={formatFullTime(version.createdAt)}>{formatRelativeTime(version.createdAt)}</span>
                  </div>
                  <div className="text-[11px] mt-1 pl-[18px] flex items-center gap-2" style={{ color: "var(--app-text-tertiary)" }}>
                    <span>{formatSize(version.size)}</span>
                    {version.branch ? (
                      <Badge variant="outline" className="text-[10px] px-1 h-[18px]" style={{ borderColor: "var(--app-accent)", color: "var(--app-accent)" }}>
                        <GitBranch size={10} className="mr-1" />{version.branch}
                      </Badge>
                    ) : fileBranches.length > 1 ? (
                      <span className="text-[10px] opacity-60">{t("unknownBranch")}</span>
                    ) : null}
                  </div>
                  {getVersionLabels(version.id).length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5 pl-[18px]">
                      {getVersionLabels(version.id).map((label) => (
                        <Badge
                          key={label.id}
                          variant="outline"
                          className="text-[10px] px-1.5 h-[18px]"
                          style={{ borderColor: getLabelColor(label.source), color: getLabelColor(label.source) }}
                        >
                          <Tag size={10} className="mr-1" />{label.name}
                        </Badge>
                      ))}
                    </div>
                  )}
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-44">
                    <ContextMenuItem onSelect={() => openLabelDialog(version)}>
                      <Tag size={14} />
                      {t("addTag")}
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => restoreVersion(version)}>
                      <RotateCcw size={14} />
                      {t("restoreVersion")}
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

import { useState, useMemo } from "react";
import { Trash2, Play, ChevronDown, ChevronRight, Info, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatRelativeTime } from "@/utils";
import { groupByWorkspace } from "@/utils/groupLaunches";
import ResumeDetailPopover from "@/components/sidebar/ResumeDetailPopover";
import type { LaunchRecord } from "@/services";

interface RecentLaunchesProps {
  launchHistory: LaunchRecord[];
  onOpenTerminal: (path: string, resumeId?: string, workspacePath?: string, launchCwd?: string) => void;
  onClearHistory: () => void;
  onDeleteRecord: (id: number) => void;
}

export default function RecentLaunches({ launchHistory, onOpenTerminal, onClearHistory, onDeleteRecord }: RecentLaunchesProps) {
  const { t } = useTranslation("sidebar");

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

  const handleResume = (path: string, resumeId: string, workspacePath?: string, launchCwd?: string) => {
    onOpenTerminal(path, resumeId, workspacePath, launchCwd);
  };

  // 无可恢复会话
  if (groups.length === 0) {
    return (
      <div className="px-3 py-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--app-text-tertiary)]">
            {t("recentLaunches")}
          </span>
          {launchHistory.length > 0 && (
            <button
              className="transition-colors p-1 rounded-md text-[var(--app-text-tertiary)] hover:bg-[var(--app-hover)] hover:text-[var(--destructive)]"
              onClick={onClearHistory}
              title={t("clearHistory")}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <p className="text-xs mt-1 text-[var(--app-text-tertiary)]">
          {t("noResumableSessions")}
        </p>
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
        <button
          className="transition-colors p-1 rounded-md text-[var(--app-text-tertiary)] hover:bg-[var(--app-hover)] hover:text-[var(--destructive)]"
          onClick={onClearHistory}
          title={t("clearHistory")}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 工作空间分组 */}
      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.workspaceName);
        return (
          <div key={group.workspaceName} className="mb-1">
            {/* 组标题 */}
            <button
              className="w-full flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
              onClick={() => toggleGroup(group.workspaceName)}
            >
              {isCollapsed ? (
                <ChevronRight className="w-3 h-3 shrink-0" />
              ) : (
                <ChevronDown className="w-3 h-3 shrink-0" />
              )}
              <span className="text-[11px] font-semibold truncate">{group.workspaceName}</span>
              <span
                className="text-[9px] ml-auto shrink-0 px-1.5 py-0.5 rounded-full text-[var(--app-text-tertiary)]"
                style={{ background: "var(--app-hover)" }}
              >
                {group.records.length}
              </span>
            </button>

            {/* 会话行 */}
            {!isCollapsed && group.records.map((record) => (
              <div
                key={record.id}
                role="button"
                tabIndex={0}
                className="w-full group flex items-center justify-between px-3 pl-7 py-2 mb-0.5 rounded-xl transition-all duration-300 border border-transparent cursor-pointer text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
                onClick={() => {
                  if (!record.claudeSessionId) return;
                  handleResume(record.projectPath, record.claudeSessionId, record.workspacePath, record.launchCwd);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    if (!record.claudeSessionId) return;
                    handleResume(record.projectPath, record.claudeSessionId, record.workspacePath, record.launchCwd);
                  }
                }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Play className="w-3.5 h-3.5 text-green-500 shrink-0" />
                  <div className="min-w-0 text-left">
                    <span className="text-[12px] font-medium tracking-wide truncate block max-w-[120px]">
                      {record.projectName}
                    </span>
                    {/* Session ID subtitle for diagnostics */}
                    <span className={`text-[9px] font-mono truncate block max-w-[140px] ${
                      record.claudeSessionId
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-red-500 dark:text-red-400'
                    }`}>
                      {record.claudeSessionId
                        ? record.claudeSessionId.slice(0, 8) + '…'
                        : '⚠ no session'}
                    </span>
                    {record.lastPrompt && (
                      <span className="text-[10px] truncate block max-w-[120px] text-[var(--app-text-tertiary)]">
                        {record.lastPrompt.slice(0, 40)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <span className="text-[10px] text-[var(--app-text-tertiary)]">
                    {formatRelativeTime(record.launchedAt)}
                  </span>
                  <ResumeDetailPopover record={record} onResume={handleResume} onDelete={onDeleteRecord}>
                    <button
                      className="p-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-[var(--app-hover)] text-[var(--app-text-tertiary)]"
                    >
                      <Info className="w-3.5 h-3.5" />
                    </button>
                  </ResumeDetailPopover>
                  <button
                    className="p-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-[var(--app-hover)] text-[var(--destructive)]"
                    onClick={(e) => { e.stopPropagation(); onDeleteRecord(record.id); }}
                    title={t("deleteRecord")}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </>
  );
}

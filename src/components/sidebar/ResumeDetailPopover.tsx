import { Copy, Play, FolderOpen, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { formatFullTime } from "@/utils";
import type { LaunchRecord } from "@/services";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

interface ResumeDetailPopoverProps {
  record: LaunchRecord;
  onResume: (path: string, resumeId: string, workspacePath?: string, launchCwd?: string) => void;
  onDelete: (id: number) => void;
  children: React.ReactNode;
}

export default function ResumeDetailPopover({ record, onResume, onDelete, children }: ResumeDetailPopoverProps) {
  const { t } = useTranslation("sidebar");

  const sessionId = record.claudeSessionId ?? "";
  const truncatedId = sessionId.length > 16 ? `${sessionId.slice(0, 8)}...${sessionId.slice(-8)}` : sessionId;

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(sessionId);
      toast.success(t("copySessionId"));
    } catch {
      // fallback
    }
  };

  const handleResume = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (record.claudeSessionId) {
      onResume(record.projectPath, record.claudeSessionId, record.workspacePath, record.launchCwd);
    }
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete(record.id);
  };

  const handleOpenFolder = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await invoke("plugin:opener|reveal_item_in_dir", { path: record.projectPath });
    } catch {
      // ignore
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild onClick={(e) => e.stopPropagation()}>
        {children}
      </PopoverTrigger>
      <PopoverContent side="right" align="start" className="w-72 p-3">
        <div className="space-y-2.5">
          {/* 项目名称 */}
          <div>
            <span className="text-xs font-semibold text-[var(--app-text-primary)]">
              {record.projectName}
            </span>
            <p className="text-[10px] truncate text-[var(--app-text-tertiary)]">
              {record.projectPath}
            </p>
          </div>

          {/* Session ID */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-[var(--app-text-tertiary)]">
              {t("sessionId")}:
            </span>
            <code className="text-[10px] font-mono px-1 py-0.5 rounded" style={{ background: "var(--app-input-bg)", color: "var(--app-text-secondary)" }}>
              {truncatedId}
            </code>
            <button
              onClick={handleCopy}
              className="p-0.5 rounded transition-colors hover:bg-[var(--app-hover)] text-[var(--app-text-tertiary)]"
            >
              <Copy className="w-3 h-3" />
            </button>
          </div>

          {/* 启动时间 */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-[var(--app-text-tertiary)]">
              {t("launchTime")}:
            </span>
            <span className="text-[10px] text-[var(--app-text-secondary)]">
              {formatFullTime(record.launchedAt)}
            </span>
          </div>

          {/* Last Prompt */}
          {record.lastPrompt && (
            <div>
              <span className="text-[10px] text-[var(--app-text-tertiary)]">
                {t("lastPromptLabel")}:
              </span>
              <p className="text-[10px] mt-0.5 leading-relaxed line-clamp-3 text-[var(--app-text-secondary)]">
                {record.lastPrompt}
              </p>
            </div>
          )}

          {/* 操作按钮 */}
          <div className="flex gap-2 pt-1">
            <button
              onClick={handleResume}
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium bg-green-600 text-white hover:bg-green-700 transition-colors"
            >
              <Play className="w-3 h-3" />
              {t("resumeButton")}
            </button>
            <button
              onClick={handleOpenFolder}
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors text-[var(--app-text-secondary)]"
              style={{ background: "var(--app-hover)" }}
            >
              <FolderOpen className="w-3 h-3" />
              {t("openInFolder")}
            </button>
            <button
              onClick={handleDelete}
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors bg-red-500/10 text-red-500 hover:bg-red-500/20"
            >
              <Trash2 className="w-3 h-3" />
              {t("deleteRecord")}
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

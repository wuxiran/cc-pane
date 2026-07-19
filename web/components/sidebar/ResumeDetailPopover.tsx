import { Copy, Play, FolderOpen, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { formatFullTime, isTauriRuntime } from "@/utils";
import type { LaunchRecord } from "@/services";
import { providerService } from "@/services/providerService";
import { toast } from "sonner";

interface ResumeDetailPopoverProps {
  record: LaunchRecord;
  onResume: (record: LaunchRecord) => void;
  onDelete: (id: number) => void;
  children: React.ReactNode;
}

export default function ResumeDetailPopover({ record, onResume, onDelete, children }: ResumeDetailPopoverProps) {
  const { t } = useTranslation("sidebar");

  const sessionId = record.resumeSessionId ?? "";
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
    if (record.resumeSessionId) {
      onResume(record);
    }
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete(record.id);
  };

  const handleOpenFolder = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      if (!isTauriRuntime()) {
        await navigator.clipboard.writeText(record.projectPath);
        toast.success(t("copiedToClipboard"));
        return;
      }
      await providerService.openPathInExplorer(record.projectPath);
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
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium bg-[var(--app-status-success)] text-white hover:bg-[color-mix(in_srgb,var(--app-status-success)_85%,transparent)] transition-colors"
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
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors bg-[var(--app-status-danger-bg)] text-[var(--app-status-danger)] hover:bg-[color-mix(in_srgb,var(--app-status-danger)_20%,transparent)]"
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

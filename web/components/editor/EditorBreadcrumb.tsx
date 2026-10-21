import { useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { navigationBreadcrumbs } from "@/utils/path";
import { ChevronRight } from "lucide-react";
import { useFileBrowserStore } from "@/stores/useFileBrowserStore";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import FilePreviewActions from "./FilePreviewActions";

interface EditorBreadcrumbProps {
  filePath: string;
  projectPath?: string;
  isRemote?: boolean;
  sourceLabel?: string;
  onNavigate?: (path: string) => void;
}

export default function EditorBreadcrumb({
  filePath,
  projectPath,
  isRemote = false,
  sourceLabel,
  onNavigate,
}: EditorBreadcrumbProps) {
  const { t } = useTranslation("editor");
  const navigateTo = useFileBrowserStore((s) => s.navigateTo);
  const toggleFilesMode = useActivityBarStore((s) => s.toggleFilesMode);
  const appViewMode = useActivityBarStore((s) => s.appViewMode);

  const segments = useMemo(() => navigationBreadcrumbs(filePath, isRemote || onNavigate ? "posix" : "auto"), [filePath, isRemote, onNavigate]);

  const handleSegmentClick = useCallback(
    (path: string) => {
      if (onNavigate) {
        onNavigate(path);
        return;
      }
      if (isRemote) return;
      navigateTo(path);
      // 如果不在 files 模式，切换过去
      if (appViewMode !== "files") {
        toggleFilesMode();
      }
    },
    [navigateTo, appViewMode, isRemote, onNavigate, toggleFilesMode]
  );

  if (segments.length === 0) return null;

  return (
    <div
      className="flex shrink-0 items-center gap-2 min-h-9 px-2 py-1 overflow-hidden border-b text-[12px]"
      style={{
        background: "var(--editor-breadcrumb-bg)",
        borderColor: "var(--app-border)",
      }}
    >
      <nav aria-label={t("filePath", { defaultValue: "File path" })} className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto no-scrollbar">
        {sourceLabel && (
          <span
            className="mr-1 max-w-[140px] shrink-0 truncate font-medium"
            style={{ color: "var(--app-accent)" }}
            title={sourceLabel}
          >
            {sourceLabel}
          </span>
        )}
        {segments.map((seg, i) => (
          <span key={seg.path} className="flex items-center shrink-0">
            {i > 0 && (
              <ChevronRight
                size={10}
                className="mx-0.5"
                style={{ color: "var(--editor-breadcrumb-fg)" }}
              />
            )}
            <button
              type="button"
              aria-current={i === segments.length - 1 ? "page" : undefined}
              disabled={isRemote && !onNavigate && i < segments.length - 1}
              className="hover:underline truncate max-w-[120px] transition-colors"
              style={{
                color: i === segments.length - 1
                  ? "var(--editor-breadcrumb-fg-active)"
                  : "var(--editor-breadcrumb-fg)",
                fontWeight: i === segments.length - 1 ? 500 : 400,
              }}
              onClick={() => {
                // 最后一段是文件名，点击目录段才导航
                if (i < segments.length - 1) {
                  handleSegmentClick(seg.path);
                }
              }}
              title={seg.path}
            >
              {seg.label}
            </button>
          </span>
        ))}
      </nav>
      <FilePreviewActions filePath={filePath} projectPath={projectPath} isRemote={isRemote || Boolean(onNavigate)} />
    </div>
  );
}

import { useMemo, useCallback } from "react";
import { navigationBreadcrumbs } from "@/utils/path";
import { ChevronRight } from "lucide-react";
import { useFileBrowserStore } from "@/stores/useFileBrowserStore";
import { useActivityBarStore } from "@/stores/useActivityBarStore";

interface EditorBreadcrumbProps {
  filePath: string;
  sourceLabel?: string;
  onNavigate?: (path: string) => void;
}

export default function EditorBreadcrumb({
  filePath,
  sourceLabel,
  onNavigate,
}: EditorBreadcrumbProps) {
  const navigateTo = useFileBrowserStore((s) => s.navigateTo);
  const toggleFilesMode = useActivityBarStore((s) => s.toggleFilesMode);
  const appViewMode = useActivityBarStore((s) => s.appViewMode);

  const segments = useMemo(() => navigationBreadcrumbs(filePath, onNavigate ? "posix" : "auto"), [filePath, onNavigate]);

  const handleSegmentClick = useCallback(
    (path: string) => {
      if (onNavigate) {
        onNavigate(path);
        return;
      }
      navigateTo(path);
      // 如果不在 files 模式，切换过去
      if (appViewMode !== "files") {
        toggleFilesMode();
      }
    },
    [navigateTo, appViewMode, onNavigate, toggleFilesMode]
  );

  if (segments.length === 0) return null;

  return (
    <div
      className="flex items-center h-[22px] px-2 overflow-hidden border-b text-[12px]"
      style={{
        background: "var(--editor-breadcrumb-bg)",
        borderColor: "var(--app-border)",
      }}
    >
      <div className="flex items-center gap-0.5 overflow-hidden">
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
      </div>
    </div>
  );
}

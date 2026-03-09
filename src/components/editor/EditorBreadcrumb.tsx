import { useMemo, useCallback } from "react";
import { ChevronRight } from "lucide-react";
import { useFileBrowserStore } from "@/stores/useFileBrowserStore";
import { useActivityBarStore } from "@/stores/useActivityBarStore";

interface EditorBreadcrumbProps {
  filePath: string;
}

/** 将文件路径拆分为可点击的面包屑段 */
function parseBreadcrumbs(filePath: string): Array<{ label: string; path: string }> {
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  const segments: Array<{ label: string; path: string }> = [];
  let accumulated = "";
  for (let i = 0; i < parts.length; i++) {
    accumulated += (i === 0 && !normalized.startsWith("/") ? "" : "/") + parts[i];
    // Windows 盘符处理
    if (i === 0 && parts[i].endsWith(":")) {
      accumulated = parts[i] + "/";
    }
    segments.push({ label: parts[i], path: accumulated });
  }
  return segments;
}

export default function EditorBreadcrumb({ filePath }: EditorBreadcrumbProps) {
  const navigateTo = useFileBrowserStore((s) => s.navigateTo);
  const toggleFilesMode = useActivityBarStore((s) => s.toggleFilesMode);
  const appViewMode = useActivityBarStore((s) => s.appViewMode);

  const segments = useMemo(() => parseBreadcrumbs(filePath), [filePath]);

  const handleSegmentClick = useCallback(
    (path: string) => {
      navigateTo(path);
      // 如果不在 files 模式，切换过去
      if (appViewMode !== "files") {
        toggleFilesMode();
      }
    },
    [navigateTo, appViewMode, toggleFilesMode]
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

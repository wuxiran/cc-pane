import { useState, useCallback, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, ChevronRight } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface FileBrowserToolbarProps {
  currentPath: string;
  onNavigate: (path: string) => void;
  onRefresh: () => void;
}

export default function FileBrowserToolbar({
  currentPath,
  onNavigate,
  onRefresh,
}: FileBrowserToolbarProps) {
  const { t } = useTranslation("sidebar");
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const handleStartEdit = useCallback(() => {
    setEditValue(currentPath);
    setEditing(true);
  }, [currentPath]);

  const handleConfirmEdit = useCallback(() => {
    setEditing(false);
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== currentPath) {
      onNavigate(trimmed);
    }
  }, [editValue, currentPath, onNavigate]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        handleConfirmEdit();
      } else if (e.key === "Escape") {
        setEditing(false);
      }
    },
    [handleConfirmEdit]
  );

  // 面包屑：将路径拆成可点击的段
  const breadcrumbs = (() => {
    if (!currentPath) return [];
    const normalized = currentPath.replace(/\\/g, "/");
    const parts = normalized.split("/").filter(Boolean);
    const segments: { label: string; path: string }[] = [];
    let accumulated = "";
    for (let i = 0; i < parts.length; i++) {
      accumulated += (i === 0 && !normalized.startsWith("/") ? "" : "/") + parts[i];
      if (i === 0 && parts[i].endsWith(":")) {
        accumulated = parts[i] + "/";
      }
      segments.push({ label: parts[i], path: accumulated });
    }
    return segments;
  })();

  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-[var(--app-border)] bg-[var(--app-content)]">
      {/* 面包屑 / 编辑框 */}
      <div
        className="flex-1 min-w-0 px-2 py-1 rounded-md text-[13px] bg-[color-mix(in_srgb,var(--app-input-bg)_50%,transparent)] hover:bg-[var(--app-input-bg)] cursor-text transition-colors"
        onDoubleClick={handleStartEdit}
      >
        {editing ? (
          <input
            ref={inputRef}
            className="w-full bg-transparent outline-none text-xs"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleConfirmEdit}
            onKeyDown={handleKeyDown}
          />
        ) : (
          <div className="flex items-center gap-0.5 overflow-hidden">
            {breadcrumbs.map((seg, i) => (
              <span key={seg.path} className="flex items-center shrink-0">
                {i > 0 && (
                  <ChevronRight size={12} className="shrink-0 mx-0.5" style={{ color: "var(--app-text-tertiary)" }} />
                )}
                <button
                  className="hover:underline truncate max-w-[120px]"
                  style={{
                    color: i === breadcrumbs.length - 1
                      ? "var(--app-text-primary)"
                      : "var(--app-text-secondary)",
                  }}
                  onClick={() => onNavigate(seg.path)}
                  title={seg.path}
                >
                  {seg.label}
                </button>
              </span>
            ))}
            {breadcrumbs.length === 0 && (
              <span className="opacity-50 italic">
                {t("noPath", { defaultValue: "No path" })}
              </span>
            )}
          </div>
        )}
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className="p-1.5 rounded-md transition-colors hover:bg-[var(--app-hover)]"
            style={{ color: "var(--app-text-secondary)" }}
            onClick={onRefresh}
          >
            <RefreshCw size={14} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          <p>{t("refresh", { defaultValue: "Refresh" })}</p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

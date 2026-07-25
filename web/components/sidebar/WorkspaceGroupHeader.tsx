import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";

interface WorkspaceGroupHeaderProps {
  group: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}

export default function WorkspaceGroupHeader({
  group,
  count,
  collapsed,
  onToggle,
}: WorkspaceGroupHeaderProps) {
  const { t } = useTranslation("sidebar");
  const Chevron = collapsed ? ChevronRight : ChevronDown;

  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      aria-label={t("workspaceGroupToggle", { group })}
      onClick={onToggle}
      className="mt-1 flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[11px] font-semibold text-[var(--app-text-secondary)] outline-none transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
    >
      <Chevron className="size-3.5 shrink-0 text-[var(--app-text-tertiary)]" />
      <span className="min-w-0 flex-1 truncate">{group}</span>
      <span className="min-w-5 text-right tabular-nums text-[10px] font-medium text-[var(--app-text-tertiary)]">
        {count}
      </span>
    </button>
  );
}

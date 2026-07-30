import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";

interface WorkspaceGroupHeaderProps {
  group: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  /** 正在把工作空间拖到本组头上 */
  dropActive?: boolean;
  /** 正在拖工作空间但未悬停本组头——弱提示"这一排都是候选靶" */
  dropCandidate?: boolean;
}

export default function WorkspaceGroupHeader({
  group,
  count,
  collapsed,
  onToggle,
  dropActive = false,
  dropCandidate = false,
}: WorkspaceGroupHeaderProps) {
  const { t } = useTranslation("sidebar");
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  // 落点态复用 accent 配方（与列表行「当前」态同源）；虚线 + data 属性提供
  // 不依赖颜色的冗余区分。不可放置时零反馈——danger 留给失败/破坏性，琥珀留给等待输入。
  const dropStyle = dropActive
    ? {
        backgroundColor: "color-mix(in srgb, var(--app-accent) 12%, transparent)",
        borderColor: "var(--app-accent)",
        borderStyle: "solid" as const,
      }
    : dropCandidate
      ? {
          borderColor: "color-mix(in srgb, var(--app-accent) 35%, transparent)",
          borderStyle: "dashed" as const,
        }
      : { borderColor: "transparent", borderStyle: "solid" as const };

  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      aria-label={t("workspaceGroupToggle", { group })}
      onClick={onToggle}
      data-drop-target={dropActive ? "active" : dropCandidate ? "candidate" : undefined}
      style={dropStyle}
      className="mt-1 flex h-7 w-full items-center gap-1.5 rounded-md border px-2 text-left text-[11px] font-semibold text-[var(--app-text-secondary)] outline-none transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
    >
      <Chevron className="size-3.5 shrink-0 text-[var(--app-text-tertiary)]" />
      <span className="min-w-0 flex-1 truncate">{group}</span>
      <span className="min-w-5 text-right tabular-nums text-[10px] font-medium text-[var(--app-text-tertiary)]">
        {count}
      </span>
    </button>
  );
}

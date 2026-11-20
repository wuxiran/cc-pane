// SSH 机器列表的筛选条（全部 / 收藏 / 标签）。机器少时由调用方整条隐藏。
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Star } from "lucide-react";

export function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className="inline-flex h-6 shrink-0 items-center gap-1 rounded px-2 text-[length:var(--text-micro)] transition-colors"
      style={{
        color: active ? "var(--app-accent)" : "var(--app-text-secondary)",
        background: active ? "var(--app-accent-muted)" : "transparent",
      }}
    >
      {children}
    </button>
  );
}

interface SshMachineFilterRowProps {
  machineCount: number;
  favoriteCount: number;
  tags: readonly string[];
  activeTag: string | null;
  favoritesOnly: boolean;
  onSelectAll: () => void;
  onSelectFavorites: () => void;
  onSelectTag: (tag: string) => void;
}

export default function SshMachineFilterRow({
  machineCount,
  favoriteCount,
  tags,
  activeTag,
  favoritesOnly,
  onSelectAll,
  onSelectFavorites,
  onSelectTag,
}: SshMachineFilterRowProps) {
  const { t } = useTranslation("sidebar");
  return (
    <div
      className="no-scrollbar flex gap-1 overflow-x-auto pb-0.5"
      data-testid="ssh-machine-filters"
      aria-label={t("ssh.filters", { defaultValue: "Machine filters" })}
    >
      <FilterButton active={!favoritesOnly && activeTag === null} onClick={onSelectAll}>
        {t("ssh.filterAll", { defaultValue: "All" })}
        <span>{machineCount}</span>
      </FilterButton>
      <FilterButton active={favoritesOnly} onClick={onSelectFavorites}>
        <Star className="h-3 w-3" fill={favoriteCount > 0 ? "currentColor" : "none"} />
        {t("ssh.favorites", { defaultValue: "Favorites" })}
        <span>{favoriteCount}</span>
      </FilterButton>
      {tags.map((tag) => (
        <FilterButton
          key={tag}
          active={!favoritesOnly && activeTag === tag}
          onClick={() => onSelectTag(tag)}
        >
          {tag}
        </FilterButton>
      ))}
    </div>
  );
}

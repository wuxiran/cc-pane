import { useMemo, useState } from "react";
import { FolderTree, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useWorkspacesStore } from "@/stores";
import {
  UNGROUPED_WORKSPACE_FILTER,
  normalizedWorkspaceGroup,
} from "@/stores/useWorkspacesStore";
import { WORKSPACE_COLORS, type WorkspaceColor } from "@/types";
import WorkspaceColorDot from "./WorkspaceColorDot";

const COLOR_LABEL_KEYS = {
  red: "workspaceFilterColorRed",
  amber: "workspaceFilterColorAmber",
  green: "workspaceFilterColorGreen",
  blue: "workspaceFilterColorBlue",
  purple: "workspaceFilterColorPurple",
  pink: "workspaceFilterColorPink",
  cyan: "workspaceFilterColorCyan",
  gray: "workspaceFilterColorGray",
} as const satisfies Record<WorkspaceColor, string>;

export default function WorkspaceFilterBar() {
  const { t } = useTranslation("sidebar");
  const [groupOpen, setGroupOpen] = useState(false);
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const filter = useWorkspacesStore((state) => state.workspaceFilter);
  const setFilter = useWorkspacesStore((state) => state.setWorkspaceFilter);
  const clearFilter = useWorkspacesStore((state) => state.clearWorkspaceFilter);
  const groups = useMemo(() => {
    const values = new Set<string>();
    for (const workspace of workspaces) {
      const group = normalizedWorkspaceGroup(workspace);
      if (group) values.add(group);
    }
    return [...values];
  }, [workspaces]);
  const active =
    filter.query.trim() !== "" ||
    filter.colors.length > 0 ||
    filter.group != null;
  const selectedGroupLabel =
    filter.group === UNGROUPED_WORKSPACE_FILTER
      ? t("ungrouped")
      : (filter.group ?? t("allWorkspaceGroups"));

  const toggleColor = (color: WorkspaceColor) => {
    setFilter({
      colors: filter.colors.includes(color)
        ? filter.colors.filter((item) => item !== color)
        : [...filter.colors, color],
    });
  };

  const selectGroup = (group: string | null) => {
    setFilter({ group });
    setGroupOpen(false);
  };

  return (
    <div className="flex h-9 items-center gap-1.5 overflow-x-auto border-y border-[var(--app-border)] px-2">
      <div className="relative min-w-20 flex-1">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-[var(--app-text-tertiary)]" />
        <Input
          value={filter.query}
          onChange={(event) => setFilter({ query: event.target.value })}
          placeholder={t("workspaceSearchPlaceholder")}
          className="h-6 rounded-md pl-6 pr-2 text-xs"
        />
      </div>

      <Popover open={groupOpen} onOpenChange={setGroupOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t("workspaceGroupFilter")}
            className={`flex h-6 max-w-24 items-center gap-1 rounded-md border px-1.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] ${filter.group != null ? "border-[var(--app-accent)] text-[var(--app-accent)]" : "border-[var(--app-border)] text-[var(--app-text-secondary)]"}`}
          >
            <FolderTree className="size-3 shrink-0" />
            <span className="truncate">{selectedGroupLabel}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-48 p-1">
          <button
            type="button"
            onClick={() => selectGroup(null)}
            className="w-full rounded-sm px-2 py-1.5 text-left text-xs outline-none hover:bg-[var(--app-hover)] focus-visible:bg-[var(--app-hover)]"
          >
            {t("allWorkspaceGroups")}
          </button>
          {groups.map((group) => (
            <button
              type="button"
              key={group}
              onClick={() => selectGroup(group)}
              className="w-full truncate rounded-sm px-2 py-1.5 text-left text-xs outline-none hover:bg-[var(--app-hover)] focus-visible:bg-[var(--app-hover)]"
            >
              {group}
            </button>
          ))}
          <button
            type="button"
            onClick={() => selectGroup(UNGROUPED_WORKSPACE_FILTER)}
            className="w-full rounded-sm px-2 py-1.5 text-left text-xs outline-none hover:bg-[var(--app-hover)] focus-visible:bg-[var(--app-hover)]"
          >
            {t("ungrouped")}
          </button>
        </PopoverContent>
      </Popover>

      <div
        className="flex shrink-0 items-center gap-0.5"
        aria-label={t("workspaceColorFilter")}
      >
        {WORKSPACE_COLORS.map((color) => {
          const selected = filter.colors.includes(color);
          return (
            <button
              type="button"
              key={color}
              aria-label={t(COLOR_LABEL_KEYS[color])}
              aria-pressed={selected}
              onClick={() => toggleColor(color)}
              className={`flex size-5 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] ${selected ? "bg-[var(--app-active-bg)] ring-1 ring-[var(--app-accent)]" : "hover:bg-[var(--app-hover)]"}`}
            >
              <WorkspaceColorDot color={color} />
            </button>
          );
        })}
      </div>

      {active ? (
        <IconTooltipButton
          label={t("clearWorkspaceFilters")}
          onClick={clearFilter}
          className="size-6 shrink-0 p-0 text-[var(--app-accent)]"
        >
          <X className="size-3.5" />
        </IconTooltipButton>
      ) : null}
    </div>
  );
}

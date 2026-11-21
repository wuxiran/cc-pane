import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AutomationDef } from "@/types";
import { describeNextRun, describeSchedule } from "./automationDraft";

interface AutomationTaskListProps {
  defs: readonly AutomationDef[];
  selectedId: string | null;
  onSelect: (automationId: string) => void;
  onNew: () => void;
}

/** 左栏：标题 + 搜索、「新建任务」、按已开启 / 已暂停分组的任务列表。 */
export default function AutomationTaskList({ defs, selectedId, onSelect, onNew }: AutomationTaskListProps) {
  const { t, i18n } = useTranslation("settings");
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return defs;
    return defs.filter((def) => `${def.name}\n${def.prompt}`.toLowerCase().includes(needle));
  }, [defs, query]);
  const groups = [
    { key: "enabled", title: t("automations.sectionEnabled"), items: filtered.filter((def) => def.enabled) },
    { key: "paused", title: t("automations.sectionPaused"), items: filtered.filter((def) => !def.enabled) },
  ].filter((group) => group.items.length > 0);

  return (
    <aside
      data-testid="automation-task-list"
      className="flex w-[clamp(15rem,28%,20rem)] shrink-0 flex-col border-r border-[var(--app-border)] bg-[var(--app-panel-bg)]"
    >
      <div className="flex h-14 shrink-0 items-center gap-2 px-4">
        <h2 className="min-w-0 flex-1 truncate text-[length:var(--text-title,1.125rem)] font-semibold text-[var(--app-text-primary)]">
          {t("automations.panelTitle")}
        </h2>
        <button
          type="button"
          aria-label={t("automations.search")}
          aria-pressed={searching}
          onClick={() => {
            setSearching((value) => !value);
            setQuery("");
          }}
          className="flex size-8 items-center justify-center rounded-md text-[var(--app-text-secondary)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
        >
          {searching ? <X size={16} /> : <Search size={16} />}
        </button>
      </div>
      {searching && (
        <div className="shrink-0 px-3 pb-2">
          <input
            autoFocus
            type="search"
            aria-label={t("automations.search")}
            placeholder={t("automations.searchPlaceholder")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-8 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-content)] px-2.5 text-[length:var(--text-small)] text-[var(--app-text-primary)] outline-none placeholder:text-[var(--app-text-tertiary)] focus:border-[var(--app-accent)]"
          />
        </div>
      )}
      <div className="shrink-0 px-2">
        <button
          type="button"
          onClick={onNew}
          className="flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[length:var(--text-row)] text-[var(--app-text-primary)] transition-colors hover:bg-[var(--app-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
        >
          <Plus size={16} aria-hidden="true" />
          {t("automations.newTask")}
        </button>
      </div>
      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-3">
        {defs.length === 0 && (
          <p className="px-2.5 text-[length:var(--text-small)] leading-5 text-[var(--app-text-tertiary)]">
            {t("automations.listEmpty")}
          </p>
        )}
        {defs.length > 0 && groups.length === 0 && (
          <p className="px-2.5 text-[length:var(--text-small)] text-[var(--app-text-tertiary)]">{t("automations.noMatches")}</p>
        )}
        {groups.map((group) => (
          <section key={group.key} className="mb-3" aria-label={group.title}>
            <h3 className="mb-1 px-2.5 text-[length:var(--text-small)] text-[var(--app-text-tertiary)]">{group.title}</h3>
            <ul className="space-y-px">
              {group.items.map((def) => {
                const active = def.id === selectedId;
                return (
                  <li key={def.id}>
                    <button
                      type="button"
                      aria-current={active ? "true" : undefined}
                      onClick={() => onSelect(def.id)}
                      className={cn(
                        "flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]",
                        active ? "bg-[var(--app-active-bg)]" : "hover:bg-[var(--app-hover)]",
                      )}
                    >
                      <span className={cn("truncate text-[length:var(--text-row)]", def.enabled ? "text-[var(--app-text-primary)]" : "text-[var(--app-text-secondary)]")}>
                        {def.name || t("automations.newTask")}
                      </span>
                      <span className="truncate text-[length:var(--text-small)] text-[var(--app-text-tertiary)]">
                        {def.enabled
                          ? `${describeNextRun(def.nextRunAt, t, i18n.language)} · ${describeSchedule(def.schedule, t, i18n.language)}`
                          : describeSchedule(def.schedule, t, i18n.language)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  );
}

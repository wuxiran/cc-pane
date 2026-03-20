import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Search, List, LayoutGrid } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { BUILTIN_TODO_TYPES } from "@/stores";
import type { TodoStatus, TodoPriority } from "@/types";

export type GroupMode = "none" | "tag" | "status" | "priority" | "scope";

interface TodoFilterBarProps {
  filterStatus: TodoStatus | null;
  filterPriority: TodoPriority | null;
  filterType: string | null;
  customTypes: string[];
  searchText: string;
  groupMode: GroupMode;
  onStatusChange: (status: TodoStatus | null) => void;
  onPriorityChange: (priority: TodoPriority | null) => void;
  onTypeChange: (type: string | null) => void;
  onSearchChange: (text: string) => void;
  onGroupModeChange: (mode: GroupMode) => void;
}

function PillGroup<T>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((opt) => {
        const isActive = opt.value === value;
        return (
          <button
            key={String(opt.label)}
            onClick={() => onChange(opt.value)}
            className={`px-2.5 py-0.5 text-xs font-medium rounded-full transition-all duration-200
              ${
                isActive
                  ? "bg-primary/20 text-primary font-semibold"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
              }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/** 内置类型翻译键映射 */
const TYPE_I18N_MAP: Record<string, string> = {
  feature: "todoTypeFeature",
  bug: "todoTypeBug",
  docs: "todoTypeDocs",
  chore: "todoTypeChore",
};

export default function TodoFilterBar({
  filterStatus,
  filterPriority,
  filterType,
  customTypes,
  searchText,
  groupMode,
  onStatusChange,
  onPriorityChange,
  onTypeChange,
  onSearchChange,
  onGroupModeChange,
}: TodoFilterBarProps) {
  const { t } = useTranslation("dialogs");

  const STATUS_OPTIONS: { value: TodoStatus | null; label: string }[] = [
    { value: null, label: t("todoAll") },
    { value: "todo", label: t("todoTodo") },
    { value: "in_progress", label: t("todoInProgress") },
    { value: "done", label: t("todoDone") },
  ];

  const PRIORITY_OPTIONS: { value: TodoPriority | null; label: string }[] = [
    { value: null, label: t("todoAll") },
    { value: "high", label: t("todoPriorityHigh") },
    { value: "medium", label: t("todoPriorityMedium") },
    { value: "low", label: t("todoPriorityLow") },
  ];

  const TYPE_OPTIONS = useMemo((): { value: string | null; label: string }[] => {
    const allTypes = [...BUILTIN_TODO_TYPES, ...customTypes.filter((ct) => !BUILTIN_TODO_TYPES.includes(ct as typeof BUILTIN_TODO_TYPES[number]))];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tAny = t as any;
    return [
      { value: null, label: t("todoTypeAll") },
      ...allTypes.map((tp) => ({
        value: tp as string,
        label: (TYPE_I18N_MAP[tp] ? tAny(TYPE_I18N_MAP[tp]) : tp) as string,
      })),
    ];
  }, [customTypes, t]);

  const GROUP_MODE_OPTIONS: { value: GroupMode; label: string }[] = [
    { value: "none", label: t("todoGroupNone") },
    { value: "tag", label: t("todoGroupByTag") },
    { value: "status", label: t("todoGroupByStatus") },
    { value: "priority", label: t("todoGroupByPriority") },
    { value: "scope", label: t("todoGroupByScope") },
  ];

  return (
    <div className="px-3 py-2.5 border-b border-border/50 space-y-2.5">
      {/* 搜索框 + 分组切换 */}
      <div className="flex items-center gap-1.5">
        <div className="relative group flex-1">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground group-focus-within:text-primary transition-colors"
          />
          <Input
            value={searchText}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t("todoSearchPlaceholder")}
            className="h-9 text-sm pl-8 bg-card border border-border/40 rounded-full shadow-sm focus:bg-card focus:border-primary/50 focus:ring-2 focus:ring-primary/10 transition-all"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant={groupMode !== "none" ? "secondary" : "ghost"}
              className="h-8 w-8 shrink-0"
              title={t("todoGroupMode")}
            >
              {groupMode !== "none" ? <LayoutGrid size={14} /> : <List size={14} />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={4}>
            {GROUP_MODE_OPTIONS.map((opt) => (
              <DropdownMenuItem
                key={opt.value}
                onClick={() => onGroupModeChange(opt.value)}
                className={groupMode === opt.value ? "bg-accent" : ""}
              >
                {opt.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* 筛选器 - 药丸横向布局 */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
        <div className="bg-card/80 rounded-xl px-1.5 py-0.5">
          <PillGroup
            options={STATUS_OPTIONS}
            value={filterStatus}
            onChange={onStatusChange}
          />
        </div>

        <div className="w-px h-4 bg-border/40 shrink-0" />

        <div className="bg-card/80 rounded-xl px-1.5 py-0.5">
          <PillGroup
            options={PRIORITY_OPTIONS}
            value={filterPriority}
            onChange={onPriorityChange}
          />
        </div>

        <div className="w-px h-4 bg-border/40 shrink-0" />

        <div className="bg-card/80 rounded-xl px-1.5 py-0.5">
          <PillGroup
            options={TYPE_OPTIONS}
            value={filterType}
            onChange={onTypeChange}
          />
        </div>
      </div>
    </div>
  );
}

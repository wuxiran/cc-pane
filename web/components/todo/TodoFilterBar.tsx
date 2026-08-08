import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowDownUp,
  Bookmark,
  BookmarkPlus,
  Check,
  LayoutGrid,
  MoreHorizontal,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BUILTIN_TODO_TYPES } from "@/stores";
import type { TodoPriority, TodoSavedFilter, TodoSortBy, TodoStatus } from "@/types";

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
  sortBy?: TodoSortBy;
  onSortChange?: (sortBy: TodoSortBy) => void;
  onClearFilters?: () => void;
  savedFilters?: TodoSavedFilter[];
  onSaveFilter?: (name: string) => void;
  onApplySavedFilter?: (filter: TodoSavedFilter) => void;
  onRemoveSavedFilter?: (id: string) => void;
}

const TYPE_I18N_MAP: Record<string, string> = {
  feature: "todoTypeFeature",
  bug: "todoTypeBug",
  docs: "todoTypeDocs",
  chore: "todoTypeChore",
};

function SelectedMark({ selected }: { selected: boolean }) {
  return <span className="ml-auto w-4">{selected && <Check size={13} />}</span>;
}

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
  sortBy = "manual",
  onSortChange = () => undefined,
  onClearFilters = () => undefined,
  savedFilters = [],
  onSaveFilter = () => undefined,
  onApplySavedFilter = () => undefined,
  onRemoveSavedFilter = () => undefined,
}: TodoFilterBarProps) {
  const { t } = useTranslation("dialogs");
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");

  const statusOptions: { value: TodoStatus | null; label: string }[] = [
    { value: null, label: t("todoAll") },
    { value: "todo", label: t("todoTodo") },
    { value: "in_progress", label: t("todoInProgress") },
    { value: "done", label: t("todoDone") },
  ];
  const priorityOptions: { value: TodoPriority | null; label: string }[] = [
    { value: null, label: t("todoAll") },
    { value: "high", label: t("todoPriorityHigh") },
    { value: "medium", label: t("todoPriorityMedium") },
    { value: "low", label: t("todoPriorityLow") },
  ];
  const typeOptions = useMemo(() => {
    const translate = t as unknown as (key: string) => string;
    const allTypes = [
      ...BUILTIN_TODO_TYPES,
      ...customTypes.filter((type) => !BUILTIN_TODO_TYPES.includes(type as typeof BUILTIN_TODO_TYPES[number])),
    ];
    return [
      { value: null, label: t("todoTypeAll") },
      ...allTypes.map((type) => ({
        value: type as string,
        label: TYPE_I18N_MAP[type] ? translate(TYPE_I18N_MAP[type]) : type,
      })),
    ];
  }, [customTypes, t]);
  const groupOptions: { value: GroupMode; label: string }[] = [
    { value: "none", label: t("todoGroupNone") },
    { value: "tag", label: t("todoGroupByTag") },
    { value: "status", label: t("todoGroupByStatus") },
    { value: "priority", label: t("todoGroupByPriority") },
    { value: "scope", label: t("todoGroupByScope") },
  ];
  const sortOptions: { value: TodoSortBy; label: string }[] = [
    { value: "manual", label: t("todoSortManual") },
    { value: "priority", label: t("todoSortPriority") },
    { value: "due_date", label: t("todoSortDueDate") },
    { value: "updated_at", label: t("todoSortUpdated") },
    { value: "created_at", label: t("todoSortCreated") },
  ];

  const activeFilterCount = [filterStatus, filterPriority, filterType].filter(Boolean).length;
  const hasFilters = activeFilterCount > 0 || Boolean(searchText.trim());
  const statusLabel = statusOptions.find((option) => option.value === filterStatus)?.label;
  const priorityLabel = priorityOptions.find((option) => option.value === filterPriority)?.label;
  const typeLabel = typeOptions.find((option) => option.value === filterType)?.label;

  const saveFilter = () => {
    if (!saveName.trim()) return;
    onSaveFilter(saveName);
    setSaveName("");
    setSaveOpen(false);
  };

  return (
    <div className="space-y-2 border-b border-border/50 px-4 py-2.5">
      <div className="flex items-center gap-2">
        <div className="group relative flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground group-focus-within:text-primary" />
          <Input
            value={searchText}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={t("todoSearchPlaceholder")}
            className="h-9 rounded-md border-border/50 bg-card pl-8 pr-8 text-sm"
          />
          {searchText && (
            <button
              type="button"
              aria-label={t("todoClearSearch")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => onSearchChange("")}
            >
              <X size={13} />
            </button>
          )}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant={activeFilterCount ? "secondary" : "outline"} size="sm" className="h-9 gap-1.5 px-3">
              <SlidersHorizontal size={14} />
              {t("todoFilters")}
              {activeFilterCount > 0 && <span className="text-xs tabular-nums">{activeFilterCount}</span>}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>{t("todoStatus")}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {statusOptions.map((option) => (
                  <DropdownMenuItem key={String(option.value)} onClick={() => onStatusChange(option.value)}>
                    {option.label}<SelectedMark selected={filterStatus === option.value} />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>{t("todoPriority")}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {priorityOptions.map((option) => (
                  <DropdownMenuItem key={String(option.value)} onClick={() => onPriorityChange(option.value)}>
                    {option.label}<SelectedMark selected={filterPriority === option.value} />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>{t("todoType")}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {typeOptions.map((option) => (
                  <DropdownMenuItem key={String(option.value)} onClick={() => onTypeChange(option.value)}>
                    {option.label}<SelectedMark selected={filterType === option.value} />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {hasFilters && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={onClearFilters}>
                  <X size={13} />{t("todoClearFilters")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant={sortBy !== "manual" || groupMode !== "none" ? "secondary" : "ghost"} className="h-9 w-9" title={t("todoMoreActions")}>
              <MoreHorizontal size={16} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><ArrowDownUp size={14} />{t("todoSort")}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {sortOptions.map((option) => (
                  <DropdownMenuItem key={option.value} onClick={() => onSortChange(option.value)}>
                    {option.label}<SelectedMark selected={sortBy === option.value} />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><LayoutGrid size={14} />{t("todoGroupMode")}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {groupOptions.map((option) => (
                  <DropdownMenuItem key={option.value} onClick={() => onGroupModeChange(option.value)}>
                    {option.label}<SelectedMark selected={groupMode === option.value} />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setSaveOpen(true)}>
              <BookmarkPlus size={14} />{t("todoSaveFilter")}
            </DropdownMenuItem>
            {savedFilters.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger><Bookmark size={14} />{t("todoSavedFilters")}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-56">
                  {savedFilters.map((filter) => (
                    <DropdownMenuItem key={filter.id} onClick={() => onApplySavedFilter(filter)} className="group">
                      <span className="min-w-0 flex-1 truncate">{filter.name}</span>
                      <button
                        type="button"
                        aria-label={t("todoDeleteSavedFilter")}
                        className="ml-auto text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
                        onClick={(event) => {
                          event.stopPropagation();
                          onRemoveSavedFilter(filter.id);
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {(filterStatus || filterPriority || filterType || sortBy !== "manual" || groupMode !== "none") && (
        <div className="flex items-center gap-1.5 overflow-x-auto text-[11px]">
          {filterStatus && <span className="rounded bg-primary/10 px-2 py-1 text-primary">{statusLabel}</span>}
          {filterPriority && <span className="rounded bg-primary/10 px-2 py-1 text-primary">{t("todoPriority")}: {priorityLabel}</span>}
          {filterType && <span className="rounded bg-primary/10 px-2 py-1 text-primary">{typeLabel}</span>}
          {sortBy !== "manual" && <span className="rounded bg-muted px-2 py-1 text-muted-foreground">{sortOptions.find((option) => option.value === sortBy)?.label}</span>}
          {groupMode !== "none" && <span className="rounded bg-muted px-2 py-1 text-muted-foreground">{groupOptions.find((option) => option.value === groupMode)?.label}</span>}
          <button type="button" onClick={onClearFilters} className="text-muted-foreground hover:text-foreground" title={t("todoClearFilters")}>
            <X size={12} />
          </button>
        </div>
      )}

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("todoSaveFilter")}</DialogTitle>
            <DialogDescription>{t("todoSaveFilterDescription")}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={saveName}
            onChange={(event) => setSaveName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") saveFilter();
            }}
            placeholder={t("todoSavedFilterNamePlaceholder")}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveOpen(false)}>{t("todoCancel")}</Button>
            <Button onClick={saveFilter} disabled={!saveName.trim()}>{t("todoSave")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

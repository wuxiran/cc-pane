import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { Check, CheckSquare, ListTodo, Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import TodoViewSwitcher from "./TodoViewSwitcher";
import TodoFilterBar, { type GroupMode } from "./TodoFilterBar";
import { SortableTodoListItem } from "./TodoListItem";
import TodoTagGroup from "./TodoTagGroup";
import TodoResizeHandle from "./TodoResizeHandle";
import type {
  TodoItem,
  TodoPriority,
  TodoSavedFilter,
  TodoScope,
  TodoSortBy,
  TodoStats,
  TodoStatus,
  TodoWorkView,
} from "@/types";

interface TodoTaskListPanelProps {
  width: number;
  todos: TodoItem[];
  total: number;
  loading: boolean;
  selectedTodo: TodoItem | null;
  filterStatus: TodoStatus | null;
  filterScope: TodoScope | null;
  filterPriority: TodoPriority | null;
  filterType: string | null;
  sortBy: TodoSortBy;
  selectedIds: string[];
  stats: TodoStats | null;
  savedFilters: TodoSavedFilter[];
  searchText: string;
  customTypes: string[];
  viewMode: TodoWorkView;
  selectionMode: boolean;
  groupMode: GroupMode;
  onResize: (deltaX: number) => void;
  onNew: () => void;
  onViewModeChange: (mode: TodoWorkView) => void;
  onScopeChange: (scope: TodoScope | null) => void;
  onSelectionModeChange: (value: boolean) => void;
  onClearSelection: () => void;
  onBatchStatus: (status: TodoStatus) => void;
  onStatusChange: (status: TodoStatus | null) => void;
  onPriorityChange: (priority: TodoPriority | null) => void;
  onTypeChange: (type: string | null) => void;
  onSearchChange: (text: string) => void;
  onGroupModeChange: (mode: GroupMode) => void;
  onSortChange: (sortBy: TodoSortBy) => void;
  onClearFilters: () => void;
  onSaveFilter: (name: string) => void;
  onApplySavedFilter: (filter: TodoSavedFilter) => void;
  onRemoveSavedFilter: (id: string) => void;
  onSelectTodo: (todo: TodoItem) => void;
  onToggleStatus: (todo: TodoItem) => void;
  onTogglePriority: (todo: TodoItem) => void;
  onToggleMyDay: (todo: TodoItem) => void;
  onDelete: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onReorder: (ids: string[]) => void;
  /** todoId → 派工会话 ID（AI 工作项视图的「已派」徽章数据源） */
  dispatchSessionByTodoId?: Record<string, string>;
  onOpenDispatchSession?: (sessionId: string) => void;
}

export default function TodoTaskListPanel({
  width,
  todos,
  total,
  loading,
  selectedTodo,
  filterStatus,
  filterScope,
  filterPriority,
  filterType,
  sortBy,
  selectedIds,
  stats,
  savedFilters,
  searchText,
  customTypes,
  viewMode,
  selectionMode,
  groupMode,
  onResize,
  onNew,
  onViewModeChange,
  onScopeChange,
  onSelectionModeChange,
  onClearSelection,
  onBatchStatus,
  onStatusChange,
  onPriorityChange,
  onTypeChange,
  onSearchChange,
  onGroupModeChange,
  onSortChange,
  onClearFilters,
  onSaveFilter,
  onApplySavedFilter,
  onRemoveSavedFilter,
  onSelectTodo,
  onToggleStatus,
  onTogglePriority,
  onToggleMyDay,
  onDelete,
  onToggleSelect,
  onReorder,
  dispatchSessionByTodoId,
  onOpenDispatchSession,
}: TodoTaskListPanelProps) {
  const { t } = useTranslation("dialogs");
  const groups = useMemo(() => {
    if (groupMode === "none") return null;
    const result = new Map<string, TodoItem[]>();
    for (const todo of todos) {
      const keys =
        groupMode === "tag"
          ? todo.tags.length > 0 ? todo.tags : ["__untagged__"]
          : groupMode === "status" ? [todo.status]
            : groupMode === "priority" ? [todo.priority] : [todo.scope];
      for (const key of keys) {
        const list = result.get(key) ?? [];
        list.push(todo);
        result.set(key, list);
      }
    }
    return result;
  }, [todos, groupMode]);

  const groupLabelMap = useMemo((): Record<string, string> | null => {
    if (groupMode === "none" || groupMode === "tag") return null;
    if (groupMode === "status") {
      return { todo: t("todoTodo"), in_progress: t("todoInProgress"), done: t("todoDone") };
    }
    if (groupMode === "priority") {
      return { high: t("todoPriorityHigh"), medium: t("todoPriorityMedium"), low: t("todoPriorityLow") };
    }
    return {
      global: t("todoScopeGlobal"),
      workspace: t("todoScopeWorkspace"),
      project: t("todoScopeProject"),
      external: t("todoScopeExternal"),
      temp_script: t("todoScopeScript"),
    };
  }, [groupMode, t]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );
  const handleDragEnd = (event: DragEndEvent) => {
    if (sortBy !== "manual") return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = todos.findIndex((todo) => todo.id === active.id);
    const newIndex = todos.findIndex((todo) => todo.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    onReorder(arrayMove(todos, oldIndex, newIndex).map((todo) => todo.id));
  };

  const showListTools = todos.length > 0 || Boolean(
    searchText.trim() || filterStatus || filterPriority || filterType || sortBy !== "manual" || groupMode !== "none",
  );

  return (
    <div className="flex h-full shrink-0">
      <section className="shape-surface flex min-w-0 shrink-0 flex-col" style={{ width, background: "var(--app-sidebar-bg)" }}>
        <header className="border-b border-border/50 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <span className="flex shrink-0 items-center gap-1.5 text-sm font-semibold text-primary"><ListTodo size={15} />TodoList</span>
                <span className="text-muted-foreground/40">/</span>
                <TodoViewSwitcher viewMode={viewMode} activeScope={filterScope} stats={stats} onViewModeChange={onViewModeChange} onScopeChange={onScopeChange} />
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{t("todoTaskCount", { count: total })}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onNew} title={t("todoNewTask")} aria-label={t("todoNewTask")}><Plus size={16} /></Button>
              {todos.length > 0 && (
                <Button size="icon" variant={selectionMode ? "secondary" : "ghost"} className="h-8 w-8" onClick={() => { onSelectionModeChange(!selectionMode); onClearSelection(); }} title={t("todoMultiSelect")}>
                  <CheckSquare size={15} />
                </Button>
              )}
            </div>
          </div>
        </header>

        {selectionMode && (
          <div className="flex items-center gap-2 border-b border-border/50 bg-muted/20 px-4 py-2 text-xs">
            <span className="text-muted-foreground">{t("todoSelectedCount", { count: selectedIds.length })}</span>
            <Button size="sm" variant="ghost" className="h-7 gap-1 px-2" disabled={!selectedIds.length} onClick={() => onBatchStatus("in_progress")}><Loader2 size={13} />{t("todoInProgress")}</Button>
            <Button size="sm" variant="ghost" className="h-7 gap-1 px-2" disabled={!selectedIds.length} onClick={() => onBatchStatus("done")}><Check size={13} />{t("todoDone")}</Button>
            <Button size="icon" variant="ghost" className="ml-auto h-7 w-7" onClick={() => { onClearSelection(); onSelectionModeChange(false); }} title={t("todoCancelSelection")}><X size={14} /></Button>
          </div>
        )}

        {showListTools && <TodoFilterBar
          filterStatus={filterStatus} filterPriority={filterPriority} filterType={filterType} customTypes={customTypes}
          searchText={searchText} groupMode={groupMode} onStatusChange={onStatusChange} onPriorityChange={onPriorityChange}
          onTypeChange={onTypeChange} onSearchChange={onSearchChange} onGroupModeChange={onGroupModeChange}
          sortBy={sortBy} onSortChange={onSortChange} onClearFilters={onClearFilters} savedFilters={savedFilters}
          onSaveFilter={onSaveFilter} onApplySavedFilter={onApplySavedFilter} onRemoveSavedFilter={onRemoveSavedFilter}
        />}

        <div className="app-scrollbar flex-1 overflow-y-auto px-3 py-2">
          {loading && <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 size={16} className="animate-spin" /><span>{t("loading", { ns: "common" })}</span></div>}
          {!loading && todos.length === 0 && <EmptyState icon={ListTodo} title={t("noTasks")} className="py-24" />}
          {!loading && groups && [...groups.entries()].map(([key, groupTodos]) => (
            <TodoTagGroup key={key} tag={key} label={groupLabelMap?.[key]} todos={groupTodos} selectedId={selectedTodo?.id}
              onSelect={onSelectTodo} onToggleStatus={onToggleStatus} onTogglePriority={onTogglePriority} onDelete={onDelete}
              selectionMode={selectionMode} selectedIds={selectedIds} onToggleSelect={onToggleSelect} />
          ))}
          {!loading && !groups && (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={todos.map((todo) => todo.id)} strategy={verticalListSortingStrategy}>
                {todos.map((todo) => <SortableTodoListItem key={todo.id} todo={todo} isSelected={selectedTodo?.id === todo.id}
                  onSelect={() => onSelectTodo(todo)} onToggleStatus={() => onToggleStatus(todo)} onTogglePriority={() => onTogglePriority(todo)}
                  onToggleMyDay={() => onToggleMyDay(todo)} onDelete={onDelete} selectionMode={selectionMode}
                  isMultiSelected={selectedIds.includes(todo.id)} onToggleSelect={() => onToggleSelect(todo.id)} dragDisabled={sortBy !== "manual"}
                  dispatchSessionId={dispatchSessionByTodoId?.[todo.id]} onOpenDispatchSession={onOpenDispatchSession} />)}
              </SortableContext>
            </DndContext>
          )}
        </div>
      </section>
      <TodoResizeHandle label={t("todoResizeTaskList")} onResize={onResize} />
    </div>
  );
}

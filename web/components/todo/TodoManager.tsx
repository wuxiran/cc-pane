import { useState, useEffect, useCallback, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Plus,
  ListTodo,
  Loader2,
  CheckSquare,
  X,
  Check,
} from "lucide-react";
import {
  DndContext,
  closestCenter,
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
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { useTodoStore } from "@/stores";
import { clampSidebarWidth, loadSidebarWidth, saveSidebarWidth } from "@/lib/sidebarWidth";
import TodoViewSwitcher from "./TodoViewSwitcher";
import TodoFilterBar, { type GroupMode } from "./TodoFilterBar";
import { SortableTodoListItem } from "./TodoListItem";
import TodoTagGroup from "./TodoTagGroup";
import TodoEditor from "./TodoEditor";
import TodoOverview from "./TodoOverview";
import TodoResizeHandle from "./TodoResizeHandle";
import type { TodoEditForm } from "./TodoEditor";
import type {
  TodoItem,
  TodoPriority,
  TodoStatus,
  TodoScope,
  CreateTodoRequest,
  UpdateTodoRequest,
} from "@/types";

interface TodoManagerProps {
  /** Tab 的 scope 值（如 "workspace" / "project" / ""） */
  scope: string;
  /** Tab 的 scopeRef 值（如工作空间名或项目路径） */
  scopeRef: string;
  /** Defers Todo loading until the view has been visited. */
  enabled?: boolean;
  /** Lets the app shell place Todo's list in the shared sidebar transition. */
  children?: (parts: TodoManagerParts) => ReactNode;
}

interface TodoManagerParts {
  sidebar: ReactNode;
  content: ReactNode;
}

/** 状态循环：todo → in_progress → done → todo */
function nextStatus(current: TodoStatus): TodoStatus {
  const cycle: TodoStatus[] = ["todo", "in_progress", "done"];
  const idx = cycle.indexOf(current);
  return cycle[(idx + 1) % cycle.length];
}

function nextPriority(current: TodoPriority): TodoPriority {
  const cycle: TodoPriority[] = ["low", "medium", "high"];
  const index = cycle.indexOf(current);
  return cycle[(index + 1) % cycle.length];
}

export default function TodoManager({
  scope,
  scopeRef,
  enabled = true,
  children,
}: TodoManagerProps) {
  const { t } = useTranslation("dialogs");
  const { t: tNotify } = useTranslation("notifications");

  const todos = useTodoStore((s) => s.todos);
  const total = useTodoStore((s) => s.total);
  const loading = useTodoStore((s) => s.loading);
  const selectedTodo = useTodoStore((s) => s.selectedTodo);
  const filterStatus = useTodoStore((s) => s.filterStatus);
  const filterScope = useTodoStore((s) => s.filterScope);
  const filterPriority = useTodoStore((s) => s.filterPriority);
  const filterType = useTodoStore((s) => s.filterType);
  const sortBy = useTodoStore((s) => s.sortBy);
  const selectedIds = useTodoStore((s) => s.selectedIds);
  const stats = useTodoStore((s) => s.stats);
  const activities = useTodoStore((s) => s.activities);
  const activitiesLoading = useTodoStore((s) => s.activitiesLoading);
  const savedFilters = useTodoStore((s) => s.savedFilters);
  const searchText = useTodoStore((s) => s.searchText);
  const loadList = useTodoStore((s) => s.loadList);
  const create = useTodoStore((s) => s.create);
  const update = useTodoStore((s) => s.update);
  const remove = useTodoStore((s) => s.remove);
  const select = useTodoStore((s) => s.select);
  const setFilterStatus = useTodoStore((s) => s.setFilterStatus);
  const setFilterScope = useTodoStore((s) => s.setFilterScope);
  const setFilterPriority = useTodoStore((s) => s.setFilterPriority);
  const setFilterType = useTodoStore((s) => s.setFilterType);
  const clearFilters = useTodoStore((s) => s.clearFilters);
  const setSortBy = useTodoStore((s) => s.setSortBy);
  const toggleSelected = useTodoStore((s) => s.toggleSelected);
  const clearSelection = useTodoStore((s) => s.clearSelection);
  const batchUpdateStatus = useTodoStore((s) => s.batchUpdateStatus);
  const customTypes = useTodoStore((s) => s.customTypes);
  const setSearchText = useTodoStore((s) => s.setSearchText);
  const setContext = useTodoStore((s) => s.setContext);
  const reset = useTodoStore((s) => s.reset);
  const viewMode = useTodoStore((s) => s.viewMode);
  const setViewMode = useTodoStore((s) => s.setViewMode);
  const toggleMyDay = useTodoStore((s) => s.toggleMyDay);
  const reorder = useTodoStore((s) => s.reorder);
  const addSubtask = useTodoStore((s) => s.addSubtask);
  const toggleSubtask = useTodoStore((s) => s.toggleSubtask);
  const deleteSubtask = useTodoStore((s) => s.deleteSubtask);
  const loadActivities = useTodoStore((s) => s.loadActivities);
  const saveCurrentFilter = useTodoStore((s) => s.saveCurrentFilter);
  const applySavedFilter = useTodoStore((s) => s.applySavedFilter);
  const removeSavedFilter = useTodoStore((s) => s.removeSavedFilter);

  const [isCreating, setIsCreating] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [groupMode, setGroupMode] = useState<GroupMode>("none");
  const [listWidth, setListWidth] = useState(loadSidebarWidth);
  const [editForm, setEditForm] = useState<TodoEditForm>({
    title: "",
    description: "",
    status: "todo",
    priority: "medium",
    scope: "global",
    scopeRef: "",
    tags: "",
    dueDate: "",
    reminderAt: "",
    recurrence: "",
    todoType: "",
  });

  // 初始化：设置上下文并加载
  useEffect(() => {
    if (!enabled) return;
    const validScope = scope as TodoScope | undefined;
    if (validScope && scopeRef) {
      setContext(validScope, scopeRef);
    }
    loadList();
    return () => reset();
  }, [enabled, scope, scopeRef, setContext, loadList, reset]);

  // 搜索去抖
  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => {
      loadList();
    }, 300);
    return () => clearTimeout(timer);
  }, [enabled, searchText, loadList]);

  // 选中时填充编辑表单
  useEffect(() => {
    if (selectedTodo) {
      setEditForm({
        title: selectedTodo.title,
        description: selectedTodo.description ?? "",
        status: selectedTodo.status,
        priority: selectedTodo.priority,
        scope: selectedTodo.scope,
        scopeRef: selectedTodo.scopeRef ?? "",
        tags: selectedTodo.tags.join(", "),
        dueDate: selectedTodo.dueDate ?? "",
        reminderAt: selectedTodo.reminderAt ?? "",
        recurrence: selectedTodo.recurrence ?? "",
        todoType: selectedTodo.todoType ?? "",
      });
      setIsCreating(false);
      setIsDirty(false);
    }
  }, [selectedTodo]);

  useEffect(() => {
    if (selectedTodo && !todos.some((todo) => todo.id === selectedTodo.id)) {
      select(null);
    }
  }, [selectedTodo, todos, select]);

  useEffect(() => {
    if (selectedTodo) void loadActivities(selectedTodo.id);
  }, [selectedTodo, loadActivities]);

  // 通用分组计算
  const groups = useMemo(() => {
    if (groupMode === "none") return null;
    const result = new Map<string, TodoItem[]>();
    for (const todo of todos) {
      const keys =
        groupMode === "tag"
          ? todo.tags.length > 0
            ? todo.tags
            : ["__untagged__"]
          : groupMode === "status"
            ? [todo.status]
            : groupMode === "priority"
              ? [todo.priority]
              : [todo.scope]; // scope
      for (const key of keys) {
        const list = result.get(key) ?? [];
        list.push(todo);
        result.set(key, list);
      }
    }
    return result;
  }, [todos, groupMode]);

  // 分组标签翻译映射
  const groupLabelMap = useMemo((): Record<string, string> | null => {
    if (groupMode === "none" || groupMode === "tag") return null;
    if (groupMode === "status") {
      return {
        todo: t("todoTodo"),
        in_progress: t("todoInProgress"),
        done: t("todoDone"),
      };
    }
    if (groupMode === "priority") {
      return {
        high: t("todoPriorityHigh"),
        medium: t("todoPriorityMedium"),
        low: t("todoPriorityLow"),
      };
    }
    // scope
    return {
      global: t("todoScopeGlobal"),
      workspace: t("todoScopeWorkspace"),
      project: t("todoScopeProject"),
      external: t("todoScopeExternal"),
      temp_script: t("todoScopeScript"),
    };
  }, [groupMode, t]);

  const handleNew = useCallback(() => {
    if (isDirty && !window.confirm(t("todoUnsavedChanges"))) return;
    select(null);
    setIsCreating(true);
    setIsDirty(false);
    setEditForm({
      title: "",
      description: "",
      status: "todo",
      priority: "medium",
      scope: (scope as TodoScope) || "global",
      scopeRef: scopeRef || "",
      tags: "",
      dueDate: "",
      reminderAt: "",
      recurrence: "",
      todoType: "",
    });
  }, [isDirty, select, scope, scopeRef, t]);

  const handleSelectTodo = useCallback(
    (todo: TodoItem) => {
      if (isDirty && !window.confirm(t("todoUnsavedChanges"))) return;
      setIsDirty(false);
      select(todo);
    },
    [isDirty, select, t],
  );

  const handleSave = useCallback(async () => {
    if (!editForm.title.trim()) {
      toast.error(tNotify("titleRequired"));
      return;
    }

    const tags = editForm.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    try {
      if (isCreating) {
        const request: CreateTodoRequest = {
          title: editForm.title.trim(),
          description: editForm.description || undefined,
          status: editForm.status,
          priority: editForm.priority,
          scope: editForm.scope,
          scopeRef: editForm.scopeRef || undefined,
          tags: tags.length > 0 ? tags : undefined,
          dueDate: editForm.dueDate || undefined,
          reminderAt: editForm.reminderAt || undefined,
          recurrence: editForm.recurrence || undefined,
          todoType: editForm.todoType || undefined,
        };
        await create(request);
        setIsCreating(false);
        setIsDirty(false);
        toast.success(tNotify("todoCreated"));
      } else if (selectedTodo) {
        const request: UpdateTodoRequest = {
          title: editForm.title.trim(),
          description: editForm.description,
          status: editForm.status,
          priority: editForm.priority,
          scope: editForm.scope,
          scopeRef: editForm.scopeRef || undefined,
          tags,
          dueDate: editForm.dueDate || undefined,
          reminderAt: editForm.reminderAt || undefined,
          recurrence: editForm.recurrence || undefined,
          todoType: editForm.todoType || undefined,
        };
        await update(selectedTodo.id, request);
        setIsDirty(false);
        toast.success(tNotify("todoUpdated"));
      }
    } catch (e) {
      toast.error(tNotify("operationFailed", { error: String(e) }));
    }
  }, [editForm, isCreating, selectedTodo, create, update, tNotify]);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await remove(id);
        toast.success(tNotify("todoDeleted"));
      } catch (e) {
        toast.error(tNotify("operationFailed", { error: String(e) }));
      }
    },
    [remove, tNotify]
  );

  const handleCancel = useCallback(() => {
    if (isDirty && !window.confirm(t("todoUnsavedChanges"))) return;
    setIsCreating(false);
    setIsDirty(false);
    select(null);
  }, [isDirty, select, t]);

  const handleBatchStatus = useCallback(
    async (status: TodoStatus) => {
      try {
        await batchUpdateStatus(selectedIds, status);
        setSelectionMode(false);
        toast.success(tNotify("todoUpdated"));
      } catch (e) {
        toast.error(tNotify("operationFailed", { error: String(e) }));
      }
    },
    [batchUpdateStatus, selectedIds, tNotify],
  );

  const handleToggleStatus = useCallback(
    async (todo: TodoItem) => {
      try {
        await update(todo.id, { status: nextStatus(todo.status) });
      } catch (e) {
        toast.error(tNotify("operationFailed", { error: String(e) }));
      }
    },
    [update, tNotify]
  );

  const handleTogglePriority = useCallback(
    async (todo: TodoItem) => {
      try {
        await update(todo.id, { priority: nextPriority(todo.priority) });
      } catch (e) {
        toast.error(tNotify("operationFailed", { error: String(e) }));
      }
    },
    [update, tNotify],
  );

  const handleAddSubtask = useCallback(
    async (title: string) => {
      if (!selectedTodo) return;
      try {
        await addSubtask(selectedTodo.id, title);
      } catch (e) {
        toast.error(tNotify("operationFailed", { error: String(e) }));
      }
    },
    [selectedTodo, addSubtask, tNotify]
  );

  const handleToggleSubtask = useCallback(
    async (subtaskId: string) => {
      try {
        await toggleSubtask(subtaskId);
      } catch (e) {
        toast.error(tNotify("operationFailed", { error: String(e) }));
      }
    },
    [toggleSubtask, tNotify]
  );

  const handleDeleteSubtask = useCallback(
    async (subtaskId: string) => {
      try {
        await deleteSubtask(subtaskId);
      } catch (e) {
        toast.error(tNotify("operationFailed", { error: String(e) }));
      }
    },
    [deleteSubtask, tNotify]
  );

  // dnd-kit sensors
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor)
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (sortBy !== "manual") return;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = todos.findIndex((t) => t.id === active.id);
      const newIndex = todos.findIndex((t) => t.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      const reordered = arrayMove(todos, oldIndex, newIndex);
      reorder(reordered.map((t) => t.id));
    },
    [sortBy, todos, reorder]
  );

  const showEditor = isCreating || Boolean(selectedTodo);
  const showOverview = !showEditor;
  const showListTools = todos.length > 0 || Boolean(searchText.trim() || filterStatus || filterPriority || filterType || sortBy !== "manual" || groupMode !== "none");
  const handleListResize = useCallback((deltaX: number) => {
    setListWidth((width) => {
      const nextWidth = clampSidebarWidth(width + deltaX);
      saveSidebarWidth(nextWidth);
      return nextWidth;
    });
  }, []);

  const sidebar = (
    <div className="flex h-full shrink-0">
      {/* 任务视图与列表 */}
      <section
        className="shape-surface flex min-w-0 shrink-0 flex-col"
        style={{
          width: listWidth,
          background: "var(--app-sidebar-bg)",
        }}
      >
        {/* 头部 */}
        <header className="px-4 py-3 border-b border-border/50">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <span className="flex shrink-0 items-center gap-1.5 text-sm font-semibold text-primary">
                  <ListTodo size={15} />
                  TodoList
                </span>
                <span className="text-muted-foreground/40">/</span>
                <TodoViewSwitcher
                  viewMode={viewMode}
                  activeScope={filterScope}
                  stats={stats}
                  onViewModeChange={setViewMode}
                  onScopeChange={setFilterScope}
                />
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("todoTaskCount", { count: total })}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8"
                onClick={handleNew}
                title={t("todoNewTask")}
                aria-label={t("todoNewTask")}
              >
                <Plus size={16} />
              </Button>
              {todos.length > 0 && (
                <Button
                  size="icon"
                  variant={selectionMode ? "secondary" : "ghost"}
                  className="h-8 w-8"
                  onClick={() => {
                    setSelectionMode((value) => !value);
                    clearSelection();
                  }}
                  title={t("todoMultiSelect")}
                >
                  <CheckSquare size={15} />
                </Button>
              )}
            </div>
          </div>
        </header>

        {selectionMode && (
          <div className="flex items-center gap-2 border-b border-border/50 bg-muted/20 px-4 py-2 text-xs">
            <span className="text-muted-foreground">{t("todoSelectedCount", { count: selectedIds.length })}</span>
            <Button size="sm" variant="ghost" className="h-7 gap-1 px-2" disabled={!selectedIds.length} onClick={() => void handleBatchStatus("in_progress")}>
              <Loader2 size={13} />
              {t("todoInProgress")}
            </Button>
            <Button size="sm" variant="ghost" className="h-7 gap-1 px-2" disabled={!selectedIds.length} onClick={() => void handleBatchStatus("done")}>
              <Check size={13} />
              {t("todoDone")}
            </Button>
            <Button size="icon" variant="ghost" className="ml-auto h-7 w-7" onClick={() => { clearSelection(); setSelectionMode(false); }} title={t("todoCancelSelection")}>
              <X size={14} />
            </Button>
          </div>
        )}

        {/* 筛选栏 */}
        {showListTools && <TodoFilterBar
          filterStatus={filterStatus}
          filterPriority={filterPriority}
          filterType={filterType}
          customTypes={customTypes}
          searchText={searchText}
          groupMode={groupMode}
          onStatusChange={setFilterStatus}
          onPriorityChange={setFilterPriority}
          onTypeChange={setFilterType}
          onSearchChange={setSearchText}
          onGroupModeChange={setGroupMode}
          sortBy={sortBy}
          onSortChange={setSortBy}
          onClearFilters={clearFilters}
          savedFilters={savedFilters}
          onSaveFilter={saveCurrentFilter}
          onApplySavedFilter={applySavedFilter}
          onRemoveSavedFilter={removeSavedFilter}
        />}

        {/* 任务列表 */}
        <div className="flex-1 overflow-y-auto py-2 px-3">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 size={16} className="animate-spin" />
              <span>{t("loading", { ns: "common" })}</span>
            </div>
          )}

          {!loading && todos.length === 0 && (
            <EmptyState
              icon={ListTodo}
              title={t("noTasks")}
              className="py-24"
            />
          )}

          {/* 分组模式 */}
          {!loading && groups && (
            <>
              {[...groups.entries()].map(([key, groupTodos]) => (
                <TodoTagGroup
                  key={key}
                  tag={key}
                  label={groupLabelMap?.[key]}
                  todos={groupTodos}
                  selectedId={selectedTodo?.id}
                  onSelect={handleSelectTodo}
                  onToggleStatus={handleToggleStatus}
                  onTogglePriority={handleTogglePriority}
                  onDelete={handleDelete}
                  selectionMode={selectionMode}
                  selectedIds={selectedIds}
                  onToggleSelect={toggleSelected}
                />
              ))}
            </>
          )}

          {/* 平铺模式（可拖拽排序） */}
          {!loading && !groups && (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={todos.map((t) => t.id)}
                strategy={verticalListSortingStrategy}
              >
                {todos.map((todo) => (
                  <SortableTodoListItem
                    key={todo.id}
                    todo={todo}
                    isSelected={selectedTodo?.id === todo.id}
                    onSelect={() => handleSelectTodo(todo)}
                    onToggleStatus={() => handleToggleStatus(todo)}
                    onTogglePriority={() => handleTogglePriority(todo)}
                    onToggleMyDay={() => toggleMyDay(todo.id)}
                    onDelete={handleDelete}
                    selectionMode={selectionMode}
                    isMultiSelected={selectedIds.includes(todo.id)}
                    onToggleSelect={() => toggleSelected(todo.id)}
                    dragDisabled={sortBy !== "manual"}
                  />
                ))}
              </SortableContext>
            </DndContext>
          )}
        </div>
      </section>
      <TodoResizeHandle
        label={t("todoResizeTaskList")}
        onResize={handleListResize}
      />
    </div>
  );

  const content = showEditor ? (
    <TodoEditor
      form={editForm}
      isNew={isCreating}
      subtasks={selectedTodo?.subtasks ?? []}
      activities={activities}
      activitiesLoading={activitiesLoading}
      onChange={(form) => {
        setEditForm(form);
        setIsDirty(true);
      }}
      onSave={handleSave}
      onCancel={handleCancel}
      onDelete={selectedTodo ? () => handleDelete(selectedTodo.id) : undefined}
      onToggleSubtask={handleToggleSubtask}
      onDeleteSubtask={handleDeleteSubtask}
      onAddSubtask={handleAddSubtask}
    />
  ) : showOverview ? (
    <TodoOverview
      todos={todos}
      onSelectTodo={select}
      onToggleStatus={handleToggleStatus}
    />
  ) : null;

  if (children) return children({ sidebar, content });

  return (
    <div className="flex h-full">
      {sidebar}
      <aside
        className="h-full min-w-0 flex-1 overflow-hidden"
        style={{ background: "var(--app-panel-bg)" }}
      >
        {content}
      </aside>
    </div>
  );
}

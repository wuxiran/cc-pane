import { useState, useEffect, useCallback, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toastErr, toastOk } from "@/lib/feedback";
import { usePanesStore, useTodoStore } from "@/stores";
import { focusTab } from "@/hooks/useFocusTab";
import { asTabId } from "@/types/ids";
import { clampSidebarWidth, loadSidebarWidth, saveSidebarWidth } from "@/lib/sidebarWidth";
import { type GroupMode } from "./TodoFilterBar";
import TodoEditor from "./TodoEditor";
import TodoOverview from "./TodoOverview";
import TodoTaskListPanel from "./TodoTaskListPanel";
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
  const dispatchInfoByTodoId = useTodoStore((s) => s.dispatchInfoByTodoId);

  // todoId → sessionId（仅有会话可跳的才给徽章数据）
  const dispatchSessionByTodoId = useMemo(() => {
    const map: Record<string, string> = {};
    for (const [todoId, info] of Object.entries(dispatchInfoByTodoId)) {
      if (info.sessionId) map[todoId] = info.sessionId;
    }
    return map;
  }, [dispatchInfoByTodoId]);

  const handleOpenDispatchSession = useCallback((sessionId: string) => {
    window.requestAnimationFrame(() => {
      const panes = usePanesStore.getState();
      const location = panes.findTabBySessionAcrossLayouts(sessionId);
      if (location) {
        focusTab(asTabId(location.tab.id), { switchAppView: true });
      }
    });
  }, []);

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
      toastErr(tNotify("titleRequired"));
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
        toastOk(tNotify("todoCreated"));
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
        toastOk(tNotify("todoUpdated"));
      }
    } catch (e) {
      toastErr(tNotify("operationFailed", { error: String(e) }));
    }
  }, [editForm, isCreating, selectedTodo, create, update, tNotify]);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await remove(id);
        toastOk(tNotify("todoDeleted"));
      } catch (e) {
        toastErr(tNotify("operationFailed", { error: String(e) }));
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
        toastOk(tNotify("todoUpdated"));
      } catch (e) {
        toastErr(tNotify("operationFailed", { error: String(e) }));
      }
    },
    [batchUpdateStatus, selectedIds, tNotify],
  );

  const handleToggleStatus = useCallback(
    async (todo: TodoItem) => {
      try {
        await update(todo.id, { status: nextStatus(todo.status) });
      } catch (e) {
        toastErr(tNotify("operationFailed", { error: String(e) }));
      }
    },
    [update, tNotify]
  );

  const handleTogglePriority = useCallback(
    async (todo: TodoItem) => {
      try {
        await update(todo.id, { priority: nextPriority(todo.priority) });
      } catch (e) {
        toastErr(tNotify("operationFailed", { error: String(e) }));
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
        toastErr(tNotify("operationFailed", { error: String(e) }));
      }
    },
    [selectedTodo, addSubtask, tNotify]
  );

  const handleToggleSubtask = useCallback(
    async (subtaskId: string) => {
      try {
        await toggleSubtask(subtaskId);
      } catch (e) {
        toastErr(tNotify("operationFailed", { error: String(e) }));
      }
    },
    [toggleSubtask, tNotify]
  );

  const handleDeleteSubtask = useCallback(
    async (subtaskId: string) => {
      try {
        await deleteSubtask(subtaskId);
      } catch (e) {
        toastErr(tNotify("operationFailed", { error: String(e) }));
      }
    },
    [deleteSubtask, tNotify]
  );

  const showEditor = isCreating || Boolean(selectedTodo);
  const showOverview = !showEditor;
  const handleListResize = useCallback((deltaX: number) => {
    setListWidth((width) => {
      const nextWidth = clampSidebarWidth(width + deltaX);
      saveSidebarWidth(nextWidth);
      return nextWidth;
    });
  }, []);

  const sidebar = (
    <TodoTaskListPanel
      width={listWidth}
      todos={todos}
      total={total}
      loading={loading}
      selectedTodo={selectedTodo}
      filterStatus={filterStatus}
      filterScope={filterScope}
      filterPriority={filterPriority}
      filterType={filterType}
      sortBy={sortBy}
      selectedIds={selectedIds}
      stats={stats}
      savedFilters={savedFilters}
      searchText={searchText}
      customTypes={customTypes}
      viewMode={viewMode}
      selectionMode={selectionMode}
      groupMode={groupMode}
      onResize={handleListResize}
      onNew={handleNew}
      onViewModeChange={setViewMode}
      onScopeChange={setFilterScope}
      onSelectionModeChange={setSelectionMode}
      onClearSelection={clearSelection}
      onBatchStatus={handleBatchStatus}
      onStatusChange={setFilterStatus}
      onPriorityChange={setFilterPriority}
      onTypeChange={setFilterType}
      onSearchChange={setSearchText}
      onGroupModeChange={setGroupMode}
      onSortChange={setSortBy}
      onClearFilters={clearFilters}
      onSaveFilter={saveCurrentFilter}
      onApplySavedFilter={applySavedFilter}
      onRemoveSavedFilter={removeSavedFilter}
      onSelectTodo={handleSelectTodo}
      onToggleStatus={handleToggleStatus}
      onTogglePriority={handleTogglePriority}
      onToggleMyDay={(todo) => toggleMyDay(todo.id)}
      onDelete={handleDelete}
      onToggleSelect={toggleSelected}
      onReorder={(ids) => reorder(ids)}
      dispatchSessionByTodoId={dispatchSessionByTodoId}
      onOpenDispatchSession={handleOpenDispatchSession}
    />
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

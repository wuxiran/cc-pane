import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Plus,
  ListTodo,
  Loader2,
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
import { useTodoStore } from "@/stores";
import TodoSidebar from "./TodoSidebar";
import TodoFilterBar, { type GroupMode } from "./TodoFilterBar";
import { SortableTodoListItem } from "./TodoListItem";
import TodoTagGroup from "./TodoTagGroup";
import TodoEditor from "./TodoEditor";
import TodoOverview from "./TodoOverview";
import type { TodoEditForm } from "./TodoEditor";
import type {
  TodoItem,
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
}

/** 状态循环：todo → in_progress → done → todo */
function nextStatus(current: TodoStatus): TodoStatus {
  const cycle: TodoStatus[] = ["todo", "in_progress", "done"];
  const idx = cycle.indexOf(current);
  return cycle[(idx + 1) % cycle.length];
}

export default function TodoManager({ scope, scopeRef }: TodoManagerProps) {
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

  const [isCreating, setIsCreating] = useState(false);
  const [groupMode, setGroupMode] = useState<GroupMode>("none");
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

  // 当前视图标题
  const currentViewLabel = useMemo(() => {
    if (viewMode === "my_day") return t("todoMyDay");
    if (!filterScope) return t("todoAllTasks");
    const scopeLabels: Record<string, string> = {
      global: t("todoScopeGlobal"),
      workspace: t("todoScopeWorkspace"),
      project: t("todoScopeProject"),
      external: t("todoScopeExternal"),
      temp_script: t("todoScopeScript"),
    };
    return scopeLabels[filterScope] ?? t("todoAllTasks");
  }, [viewMode, filterScope, t]);

  // 初始化：设置上下文并加载
  useEffect(() => {
    const validScope = scope as TodoScope | undefined;
    if (validScope && scopeRef) {
      setContext(validScope, scopeRef);
    }
    loadList();
    return () => reset();
  }, [scope, scopeRef, setContext, loadList, reset]);

  // 搜索去抖
  useEffect(() => {
    const timer = setTimeout(() => {
      loadList();
    }, 300);
    return () => clearTimeout(timer);
  }, [searchText, loadList]);

  // 列表加载后自动选中第一条
  useEffect(() => {
    if (!loading && todos.length > 0 && !selectedTodo && !isCreating) {
      select(todos[0]);
    }
  }, [loading, todos, selectedTodo, isCreating, select]);

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
    }
  }, [selectedTodo]);

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
    select(null);
    setIsCreating(true);
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
  }, [select, scope, scopeRef]);

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
    setIsCreating(false);
    select(null);
  }, [select]);

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
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = todos.findIndex((t) => t.id === active.id);
      const newIndex = todos.findIndex((t) => t.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      const reordered = arrayMove(todos, oldIndex, newIndex);
      reorder(reordered.map((t) => t.id));
    },
    [todos, reorder]
  );

  const showEditor = isCreating || selectedTodo;

  return (
    <div className="flex h-full">
      {/* 左侧导航 */}
      <TodoSidebar
        viewMode={viewMode}
        activeScope={filterScope}
        onViewModeChange={setViewMode}
        onScopeChange={setFilterScope}
      />

      {/* 中间列表 */}
      <section className="flex-1 flex flex-col border-r border-border bg-background min-w-0">
        {/* 头部 */}
        <header className="px-5 py-4 border-b border-border/50">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h1 className="text-xl font-bold">{currentViewLabel}</h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                {t("todoTaskCount", { count: total })}
              </p>
            </div>
            <Button
              onClick={handleNew}
              className="gap-1.5 rounded-xl shadow-sm"
              size="sm"
            >
              <Plus size={16} />
              {t("todoNewTask")}
            </Button>
          </div>
        </header>

        {/* 筛选栏 */}
        <TodoFilterBar
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
        />

        {/* 任务列表 */}
        <div className="flex-1 overflow-y-auto py-2 px-3">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 size={16} className="animate-spin" />
              <span>{t("loading", { ns: "common" })}</span>
            </div>
          )}

          {!loading && todos.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <div className="w-16 h-16 rounded-full bg-muted/50 border border-border/30 flex items-center justify-center mx-auto mb-3">
                <ListTodo size={28} className="opacity-40" />
              </div>
              <p className="text-sm">{t("noTasks")}</p>
              <button
                onClick={handleNew}
                className="text-sm mt-1 text-primary hover:underline cursor-pointer"
              >
                {t("clickToCreate")}
              </button>
            </div>
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
                  onSelect={select}
                  onToggleStatus={handleToggleStatus}
                  onDelete={handleDelete}
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
                    onSelect={() => select(todo)}
                    onToggleStatus={() => handleToggleStatus(todo)}
                    onToggleMyDay={() => toggleMyDay(todo.id)}
                    onDelete={handleDelete}
                  />
                ))}
              </SortableContext>
            </DndContext>
          )}
        </div>
      </section>

      {/* 右侧编辑器 */}
      <aside
        className={`shrink-0 bg-card transition-all duration-200 ${
          showEditor ? "w-[480px]" : "w-0 overflow-hidden"
        }`}
      >
        {showEditor ? (
          <TodoEditor
            form={editForm}
            isNew={isCreating}
            subtasks={selectedTodo?.subtasks ?? []}
            onChange={setEditForm}
            onSave={handleSave}
            onCancel={handleCancel}
            onDelete={selectedTodo ? () => handleDelete(selectedTodo.id) : undefined}
            onToggleSubtask={handleToggleSubtask}
            onDeleteSubtask={handleDeleteSubtask}
            onAddSubtask={handleAddSubtask}
          />
        ) : (
          <TodoOverview
            todos={todos}
            onSelectTodo={select}
            onCreateNew={handleNew}
          />
        )}
      </aside>
    </div>
  );
}

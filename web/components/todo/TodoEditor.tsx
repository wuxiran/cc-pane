import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Save,
  X,
  Heading,
  Trash2,
  CircleDashed,
  Flag,
  Globe,
  Calendar,
  Bell,
  Repeat,
  Tag,
  Plus,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useWorkspacesStore, useTodoStore, BUILTIN_TODO_TYPES } from "@/stores";
import TodoSubtaskList from "./TodoSubtaskList";
import TodoActivityTimeline from "./TodoActivityTimeline";
import { PropertyRow, SegmentedControl } from "./TodoEditorControls";
import type {
  TodoStatus,
  TodoPriority,
  TodoScope,
  TodoSubtask,
  TodoActivity,
} from "@/types";

export interface TodoEditForm {
  title: string;
  description: string;
  status: TodoStatus;
  priority: TodoPriority;
  scope: TodoScope;
  scopeRef: string;
  tags: string;
  dueDate: string;
  reminderAt: string;
  recurrence: string;
  todoType: string;
}

interface TodoEditorProps {
  form: TodoEditForm;
  isNew: boolean;
  subtasks: TodoSubtask[];
  onChange: (form: TodoEditForm) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
  onToggleSubtask: (id: string) => void;
  onDeleteSubtask: (id: string) => void;
  onAddSubtask: (title: string) => void;
  activities?: TodoActivity[];
  activitiesLoading?: boolean;
}

const PRIORITY_COLOR_MAP: Record<string, string> = {
  high: "bg-[var(--app-status-danger-bg)] text-[var(--app-status-danger)] font-bold shadow-sm",
  medium: "bg-[var(--app-status-warning-bg)] text-[var(--app-status-warning)] shadow-sm",
  low: "bg-[var(--app-status-success-bg)] text-[var(--app-status-success)] shadow-sm",
};

/** 内置类型翻译键映射 */
const TYPE_I18N_MAP: Record<string, string> = {
  feature: "todoTypeFeature",
  bug: "todoTypeBug",
  docs: "todoTypeDocs",
  chore: "todoTypeChore",
};

export default function TodoEditor({
  form,
  isNew,
  subtasks,
  onChange,
  onSave,
  onCancel,
  onDelete,
  onToggleSubtask,
  onDeleteSubtask,
  onAddSubtask,
  activities = [],
  activitiesLoading = false,
}: TodoEditorProps) {
  const { t } = useTranslation("dialogs");
  const [tagInput, setTagInput] = useState("");
  const [typeInput, setTypeInput] = useState("");
  const [showTypeInput, setShowTypeInput] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(() => !isNew);

  // 工作空间/项目列表（用于 scopeRef 下拉）
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const customTypes = useTodoStore((s) => s.customTypes);
  const addCustomType = useTodoStore((s) => s.addCustomType);
  const removeCustomType = useTodoStore((s) => s.removeCustomType);

  // 收集所有项目
  const allProjects = useMemo(() => {
    return workspaces.flatMap((ws) =>
      ws.projects.map((p) => ({
        ...p,
        workspaceName: ws.alias || ws.name,
      }))
    );
  }, [workspaces]);

  // 所有类型（内置 + 自定义）
  const allTypes = useMemo(() => {
    const builtins = [...BUILTIN_TODO_TYPES];
    const extra = customTypes.filter(
      (ct) => !builtins.includes(ct as typeof BUILTIN_TODO_TYPES[number])
    );
    return [...builtins, ...extra];
  }, [customTypes]);

  const STATUS_OPTIONS: { value: TodoStatus; label: string }[] = [
    { value: "todo", label: t("todoTodo") },
    { value: "in_progress", label: t("todoInProgress") },
    { value: "done", label: t("todoDone") },
  ];

  const PRIORITY_OPTIONS: { value: TodoPriority; label: string }[] = [
    { value: "high", label: t("todoPriorityHigh") },
    { value: "medium", label: t("todoPriorityMedium") },
    { value: "low", label: t("todoPriorityLow") },
  ];

  const SCOPE_OPTIONS: { value: TodoScope; label: string }[] = [
    { value: "global", label: t("todoScopeGlobal") },
    { value: "workspace", label: t("todoScopeWorkspace") },
    { value: "project", label: t("todoScopeProject") },
    { value: "external", label: t("todoScopeExternal") },
    { value: "temp_script", label: t("todoScopeScript") },
  ];

  // Ctrl+S 保存
  useEffect(() => {
    function handleKeydown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        onSave();
      }
    }
    document.addEventListener("keydown", handleKeydown);
    return () => document.removeEventListener("keydown", handleKeydown);
  }, [onSave]);

  const needsScopeRef = form.scope === "workspace" || form.scope === "project";

  // 解析标签
  const tags = form.tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const handleRemoveTag = useCallback(
    (tagToRemove: string) => {
      const newTags = tags.filter((t) => t !== tagToRemove);
      onChange({ ...form, tags: newTags.join(", ") });
    },
    [tags, form, onChange]
  );

  const handleAddTag = useCallback(() => {
    const trimmed = tagInput.trim();
    if (trimmed && !tags.includes(trimmed)) {
      const newTags = [...tags, trimmed];
      onChange({ ...form, tags: newTags.join(", ") });
    }
    setTagInput("");
  }, [tagInput, tags, form, onChange]);

  const handleTagKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleAddTag();
      }
    },
    [handleAddTag]
  );

  const handleAddCustomType = useCallback(() => {
    const trimmed = typeInput.trim().toLowerCase();
    if (trimmed) {
      addCustomType(trimmed);
      onChange({ ...form, todoType: trimmed });
    }
    setTypeInput("");
    setShowTypeInput(false);
  }, [typeInput, addCustomType, onChange, form]);

  const getTypeLabel = useCallback(
    (tp: string): string => {
      const key = TYPE_I18N_MAP[tp];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return key ? (t as any)(key) : tp;
    },
    [t]
  );

  return (
    <div className="@container/editor flex h-full flex-col">
      {/* 头部工具栏 */}
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-border/35 bg-card px-4">
        <h2 className="truncate text-[13px] font-semibold">
          {isNew ? t("todoNewTask") : t("todoDetail")}
        </h2>
        <div className="flex items-center gap-0.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={onSave}
            className="h-7 gap-1 rounded-md bg-primary/10 px-2.5 text-xs text-primary hover:bg-primary/15 hover:text-primary"
          >
            <Save size={13} />
            {isNew ? t("create", { ns: "common" }) : t("save", { ns: "common" })}
          </Button>
          {!isNew && onDelete && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              onClick={onDelete}
              aria-label={t("delete", { ns: "common" })}
              title={t("delete", { ns: "common" })}
            >
              <Trash2 size={13} />
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            onClick={onCancel}
            aria-label={t("close", { ns: "common" })}
            title={t("close", { ns: "common" })}
          >
            <X size={13} />
          </Button>
        </div>
      </header>

      {/* 滚动内容区 */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1080px] space-y-5 px-5 py-5">
          <PropertyRow
            icon={<Heading className="h-3.5 w-3.5" />}
            label={t("todoTitle")}
          >
            <Input
              value={form.title}
              onChange={(event) => onChange({ ...form, title: event.target.value })}
              placeholder={t("todoTitlePlaceholder")}
              autoFocus={isNew}
              required
              aria-required="true"
              className="h-9 bg-background text-sm font-medium"
            />
          </PropertyRow>

          <div
            data-testid="todo-primary-properties"
            className="grid grid-cols-1 gap-x-7 gap-y-4 @min-[860px]/editor:grid-cols-2"
          >
            {/* 状态 */}
            <PropertyRow
              icon={<CircleDashed className="h-3.5 w-3.5 text-muted-foreground" />}
              label={t("todoStatus")}
            >
              <SegmentedControl
                options={STATUS_OPTIONS}
                value={form.status}
                onChange={(v) => onChange({ ...form, status: v })}
              />
            </PropertyRow>

            {/* 优先级 */}
            <PropertyRow
              icon={<Flag className="h-3.5 w-3.5 text-muted-foreground" />}
              label={t("todoPriority")}
            >
              <SegmentedControl
                options={PRIORITY_OPTIONS}
                value={form.priority}
                onChange={(v) => onChange({ ...form, priority: v })}
                colorMap={PRIORITY_COLOR_MAP}
              />
            </PropertyRow>
          </div>

          <div className="grid grid-cols-1 gap-x-7 gap-y-4 @min-[860px]/editor:grid-cols-2">
            {/* 作用域 */}
            <PropertyRow
              icon={<Globe className="h-3.5 w-3.5 text-muted-foreground" />}
              label={t("todoScope")}
            >
              <select
                value={form.scope}
                aria-label={t("todoScope")}
                onChange={(event) => onChange({
                  ...form,
                  scope: event.target.value as TodoScope,
                  scopeRef: "",
                })}
                className="h-9 w-full rounded-md border border-border/50 bg-background px-2.5 text-sm outline-none transition-colors focus:border-primary/50 focus:ring-2 focus:ring-primary/10"
              >
                {SCOPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </PropertyRow>

            {/* scopeRef - 下拉选择 */}
            {needsScopeRef && (
              <PropertyRow
                icon={<Globe className="h-3.5 w-3.5 text-muted-foreground" />}
                label={t("todoScopeRef")}
              >
                {form.scope === "workspace" ? (
                  <select
                    value={form.scopeRef}
                    onChange={(e) => onChange({ ...form, scopeRef: e.target.value })}
                    className="h-9 w-full rounded-md border border-border/50 bg-background px-2.5 text-sm outline-none transition-colors focus:border-primary/50 focus:ring-2 focus:ring-primary/10"
                  >
                    <option value="">{t("todoSelectWorkspace")}</option>
                    {workspaces.map((ws) => (
                      <option key={ws.name} value={ws.name}>
                        {ws.alias || ws.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <select
                    value={form.scopeRef}
                    onChange={(e) => onChange({ ...form, scopeRef: e.target.value })}
                    className="h-9 w-full rounded-md border border-border/50 bg-background px-2.5 text-sm outline-none transition-colors focus:border-primary/50 focus:ring-2 focus:ring-primary/10"
                  >
                    <option value="">{t("todoSelectProject")}</option>
                    {allProjects.map((p) => (
                      <option key={p.path} value={p.path}>
                        {p.alias || p.path.split(/[/\\]/).pop()} ({p.workspaceName})
                      </option>
                    ))}
                  </select>
                )}
              </PropertyRow>
            )}
          </div>

          <section className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <span>{t("todoDescription")}</span>
              <span className="rounded bg-muted/50 px-1.5 py-0.5 text-[10px] font-normal">Markdown</span>
            </div>
            <textarea
              value={form.description}
              onChange={(e) => onChange({ ...form, description: e.target.value })}
              className="min-h-[128px] w-full resize-y rounded-md border border-border/50 bg-background p-3 font-mono text-sm outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-primary/50 focus:ring-2 focus:ring-primary/10"
              placeholder={t("todoDescPlaceholder")}
              spellCheck={false}
            />
          </section>

          <button
            type="button"
            onClick={() => setShowAdvanced((value) => !value)}
            className="flex w-full items-center justify-between rounded-md bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <span>{t("todoAdvancedFields")}</span>
            {showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>

          {showAdvanced && (
            <div className="grid grid-cols-1 gap-x-7 gap-y-4 @min-[860px]/editor:grid-cols-2">
          {/* 类型 */}
          <PropertyRow
            icon={<Tag className="h-3.5 w-3.5 text-muted-foreground" />}
            label={t("todoType")}
            className="col-span-full"
          >
            <div className="flex items-center gap-1.5 flex-wrap">
              {/* 无类型选项 */}
              <button
                type="button"
                onClick={() => onChange({ ...form, todoType: "" })}
                className={`px-2.5 py-1 text-xs font-medium rounded-full transition-all duration-[var(--dur-fast)]
                  ${
                    !form.todoType
                      ? "bg-primary/15 text-primary font-semibold border border-primary/20"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                  }`}
              >
                —
              </button>
              {allTypes.map((tp) => {
                const isActive = form.todoType === tp;
                const isCustom = !BUILTIN_TODO_TYPES.includes(
                  tp as typeof BUILTIN_TODO_TYPES[number]
                );
                return (
                  <button
                    key={tp}
                    type="button"
                    onClick={() =>
                      onChange({
                        ...form,
                        todoType: isActive ? "" : tp,
                      })
                    }
                    className={`group/type relative px-2.5 py-1 text-xs font-medium rounded-full transition-all duration-[var(--dur-fast)]
                      ${
                        isActive
                          ? "bg-primary/15 text-primary font-semibold border border-primary/20"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                      }`}
                  >
                    {getTypeLabel(tp)}
                    {isCustom && (
                      <span
                        onClick={(e) => {
                          e.stopPropagation();
                          removeCustomType(tp);
                          if (form.todoType === tp) {
                            onChange({ ...form, todoType: "" });
                          }
                        }}
                        className="absolute -top-1 -right-1 hidden group-hover/type:flex w-3.5 h-3.5 items-center justify-center rounded-full bg-destructive text-destructive-foreground text-[8px] cursor-pointer"
                      >
                        ×
                      </span>
                    )}
                  </button>
                );
              })}
              {/* 添加自定义类型 */}
              {showTypeInput ? (
                <input
                  type="text"
                  value={typeInput}
                  onChange={(e) => setTypeInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddCustomType();
                    } else if (e.key === "Escape") {
                      setShowTypeInput(false);
                      setTypeInput("");
                    }
                  }}
                  onBlur={handleAddCustomType}
                  placeholder={t("todoAddType")}
                  autoFocus
                  className="w-[80px] h-6 text-xs bg-muted/30 border border-border/50 rounded-md px-1.5 outline-none focus:border-primary/50"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setShowTypeInput(true)}
                  className="rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors duration-[var(--dur-fast)] hover:bg-muted/60 hover:text-foreground"
                  title={t("todoAddType")}
                >
                  <Plus size={12} />
                </button>
              )}
            </div>
          </PropertyRow>

          {/* 到期日 */}
          <PropertyRow
            icon={<Calendar className="h-3.5 w-3.5 text-muted-foreground" />}
            label={t("todoDueDate")}
          >
            <Input
              type="date"
              value={form.dueDate ? form.dueDate.split("T")[0] : ""}
              onChange={(e) =>
                onChange({
                  ...form,
                  dueDate: e.target.value
                    ? new Date(e.target.value).toISOString()
                    : "",
                })
              }
              className="h-9 bg-background text-sm border-border/50 [&::-webkit-datetime-edit-fields-wrapper]:text-muted-foreground/30 [&:has([value=''])]:text-muted-foreground/30"
              style={form.dueDate ? { color: "var(--foreground)" } : undefined}
            />
          </PropertyRow>

          {/* 提醒 */}
          <PropertyRow
            icon={<Bell className="h-3.5 w-3.5 text-muted-foreground" />}
            label={t("todoReminderAt")}
          >
            <Input
              type="datetime-local"
              value={form.reminderAt ? form.reminderAt.slice(0, 16) : ""}
              onChange={(e) =>
                onChange({
                  ...form,
                  reminderAt: e.target.value
                    ? new Date(e.target.value).toISOString()
                    : "",
                })
              }
              className="h-9 bg-background text-sm border-border/50 [&::-webkit-datetime-edit-fields-wrapper]:text-muted-foreground/30 [&:has([value=''])]:text-muted-foreground/30"
              style={form.reminderAt ? { color: "var(--foreground)" } : undefined}
            />
          </PropertyRow>

          {/* 重复 */}
          <PropertyRow
            icon={<Repeat className="h-3.5 w-3.5 text-muted-foreground" />}
            label={t("todoRecurrence")}
          >
            <select
              value={form.recurrence || ""}
              onChange={(e) =>
                onChange({ ...form, recurrence: e.target.value })
              }
              className="h-9 w-full rounded-md border border-border/50 bg-background px-2.5 text-sm outline-none transition-colors focus:border-primary/50 focus:ring-2 focus:ring-primary/10"
            >
              <option value="">{t("todoRecurrenceNone")}</option>
              <option value="daily">{t("todoRecurrenceDaily")}</option>
              <option value="weekly">{t("todoRecurrenceWeekly")}</option>
              <option value="monthly">{t("todoRecurrenceMonthly")}</option>
            </select>
          </PropertyRow>

          {/* 标签 - chip 列表 */}
          <PropertyRow
            icon={<Tag className="h-3.5 w-3.5 text-muted-foreground" />}
            label={t("todoTags")}
          >
            <div className="flex flex-wrap items-center gap-1.5">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs"
                >
                  {tag}
                  <button
                    type="button"
                    onClick={() => handleRemoveTag(tag)}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={handleTagKeyDown}
                onBlur={handleAddTag}
                placeholder={tags.length === 0 ? t("todoTagsPlaceholder") : "+"}
                className="h-8 min-w-[100px] flex-1 rounded-md border border-border/50 bg-background px-2 text-xs outline-none placeholder:text-muted-foreground/50 focus:border-primary/50 focus:ring-2 focus:ring-primary/10"
              />
            </div>
          </PropertyRow>
            </div>
          )}

          {!isNew && (
            <div className="grid grid-cols-1 gap-x-8 gap-y-6 border-t border-border/40 pt-5 @min-[860px]/editor:grid-cols-2">
              <section className="min-w-0 space-y-2">
                <h3 className="text-xs font-medium text-muted-foreground">
                  {t("todoSubtasks")}
                </h3>
                <TodoSubtaskList
                  subtasks={subtasks}
                  onToggle={onToggleSubtask}
                  onDelete={onDeleteSubtask}
                  onAdd={onAddSubtask}
                />
              </section>
              <TodoActivityTimeline activities={activities} loading={activitiesLoading} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

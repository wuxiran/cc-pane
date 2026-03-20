import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Save,
  X,
  LayoutTemplate,
  Trash2,
  CircleDashed,
  Flag,
  Globe,
  Calendar,
  Bell,
  Repeat,
  Tag,
  Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useWorkspacesStore, useTodoStore, BUILTIN_TODO_TYPES } from "@/stores";
import TodoSubtaskList from "./TodoSubtaskList";
import type {
  TodoStatus,
  TodoPriority,
  TodoScope,
  TodoSubtask,
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
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  colorMap,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  colorMap?: Record<string, string>;
}) {
  return (
    <div className="flex p-1 bg-muted/40 rounded-xl border border-border/30">
      {options.map((opt) => {
        const isActive = opt.value === value;
        const activeColor = colorMap?.[opt.value];
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-200
              ${
                isActive
                  ? activeColor ?? "bg-primary/15 text-primary shadow-sm border border-primary/25"
                  : "text-muted-foreground hover:text-foreground"
              }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

const PRIORITY_COLOR_MAP: Record<string, string> = {
  high: "bg-rose-100 text-rose-600 dark:bg-rose-900/40 dark:text-rose-400 font-bold shadow-sm",
  medium: "bg-amber-100 text-amber-600 dark:bg-amber-900/40 dark:text-amber-400 shadow-sm",
  low: "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/40 dark:text-emerald-400 shadow-sm",
};

/** 内置类型翻译键映射 */
const TYPE_I18N_MAP: Record<string, string> = {
  feature: "todoTypeFeature",
  bug: "todoTypeBug",
  docs: "todoTypeDocs",
  chore: "todoTypeChore",
};

/** 属性行：icon + label 在左，value 在右 */
function PropertyRow({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 shrink-0 w-[100px]">
        <div className="p-1.5 bg-muted/50 rounded-full border border-border/30 flex items-center justify-center shrink-0">
          {icon}
        </div>
        <span className="text-xs font-medium text-muted-foreground">
          {label}
        </span>
      </div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

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
}: TodoEditorProps) {
  const { t } = useTranslation("dialogs");
  const [tagInput, setTagInput] = useState("");
  const [typeInput, setTypeInput] = useState("");
  const [showTypeInput, setShowTypeInput] = useState(false);

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
    <div className="flex flex-col h-full">
      {/* 头部工具栏 */}
      <header className="flex items-center justify-between px-5 py-3 border-b border-border/50 bg-background/95 backdrop-blur">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium bg-primary/10 text-primary px-2.5 py-1 rounded-md">
            <LayoutTemplate className="w-3.5 h-3.5" />
            {isNew ? t("todoNewTask") : t("todoDetail")}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            onClick={onSave}
            disabled={!form.title.trim()}
            className="h-7 text-xs gap-1"
          >
            <Save size={14} />
            {isNew ? t("create", { ns: "common" }) : t("save", { ns: "common" })}
          </Button>
          {!isNew && onDelete && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
              onClick={onDelete}
              title={t("delete", { ns: "common" })}
            >
              <Trash2 size={14} />
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={onCancel}
          >
            <X size={14} />
          </Button>
        </div>
      </header>

      {/* 滚动内容区 */}
      <div className="flex-1 overflow-y-auto">
        {/* 标题 - 沉浸式大输入框 */}
        <div className="px-5 pt-5 pb-3">
          <input
            type="text"
            value={form.title}
            onChange={(e) => onChange({ ...form, title: e.target.value })}
            placeholder={t("todoTitlePlaceholder")}
            className="w-full text-xl font-bold bg-transparent border-none placeholder:text-muted-foreground/40 focus:outline-none"
          />
        </div>

        {/* 属性区域 - 行布局 */}
        <div className="px-5 pb-5 space-y-3">
          {/* 状态 */}
          <PropertyRow
            icon={<CircleDashed className="w-3.5 h-3.5 text-muted-foreground" />}
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
            icon={<Flag className="w-3.5 h-3.5 text-muted-foreground" />}
            label={t("todoPriority")}
          >
            <SegmentedControl
              options={PRIORITY_OPTIONS}
              value={form.priority}
              onChange={(v) => onChange({ ...form, priority: v })}
              colorMap={PRIORITY_COLOR_MAP}
            />
          </PropertyRow>

          {/* 作用域 */}
          <PropertyRow
            icon={<Globe className="w-3.5 h-3.5 text-muted-foreground" />}
            label={t("todoScope")}
          >
            <SegmentedControl
              options={SCOPE_OPTIONS}
              value={form.scope}
              onChange={(v) => onChange({ ...form, scope: v, scopeRef: "" })}
            />
          </PropertyRow>

          {/* scopeRef - 下拉选择 */}
          {needsScopeRef && (
            <PropertyRow
              icon={<Globe className="w-3.5 h-3.5 text-muted-foreground" />}
              label={t("todoScopeRef")}
            >
              {form.scope === "workspace" ? (
                <select
                  value={form.scopeRef}
                  onChange={(e) =>
                    onChange({ ...form, scopeRef: e.target.value })
                  }
                  className="h-8 w-full text-xs rounded-md bg-card border border-border/40 shadow-sm px-2 focus:bg-card focus:border-primary/50 focus:ring-2 focus:ring-primary/20 transition-all outline-none"
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
                  onChange={(e) =>
                    onChange({ ...form, scopeRef: e.target.value })
                  }
                  className="h-8 w-full text-xs rounded-md bg-card border border-border/40 shadow-sm px-2 focus:bg-card focus:border-primary/50 focus:ring-2 focus:ring-primary/20 transition-all outline-none"
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

          {/* 类型 */}
          <PropertyRow
            icon={<Tag className="w-3.5 h-3.5 text-muted-foreground" />}
            label={t("todoType")}
          >
            <div className="flex items-center gap-1.5 flex-wrap">
              {/* 无类型选项 */}
              <button
                onClick={() => onChange({ ...form, todoType: "" })}
                className={`px-2.5 py-1 text-xs font-medium rounded-full transition-all duration-200
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
                    onClick={() =>
                      onChange({
                        ...form,
                        todoType: isActive ? "" : tp,
                      })
                    }
                    className={`group/type relative px-2.5 py-1 text-xs font-medium rounded-full transition-all duration-200
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
                  onClick={() => setShowTypeInput(true)}
                  className="px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 rounded-lg transition-all"
                  title={t("todoAddType")}
                >
                  <Plus size={12} />
                </button>
              )}
            </div>
          </PropertyRow>

          {/* 到期日 */}
          <PropertyRow
            icon={<Calendar className="w-3.5 h-3.5 text-muted-foreground" />}
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
              className="h-8 text-xs bg-muted/30 border-border/50 focus:bg-background [&::-webkit-datetime-edit-fields-wrapper]:text-muted-foreground/30 [&:has([value=''])]:text-muted-foreground/30"
              style={form.dueDate ? { color: "var(--foreground)" } : undefined}
            />
          </PropertyRow>

          {/* 提醒 */}
          <PropertyRow
            icon={<Bell className="w-3.5 h-3.5 text-muted-foreground" />}
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
              className="h-8 text-xs bg-muted/30 border-border/50 focus:bg-background [&::-webkit-datetime-edit-fields-wrapper]:text-muted-foreground/30 [&:has([value=''])]:text-muted-foreground/30"
              style={form.reminderAt ? { color: "var(--foreground)" } : undefined}
            />
          </PropertyRow>

          {/* 重复 */}
          <PropertyRow
            icon={<Repeat className="w-3.5 h-3.5 text-muted-foreground" />}
            label={t("todoRecurrence")}
          >
            <select
              value={form.recurrence || ""}
              onChange={(e) =>
                onChange({ ...form, recurrence: e.target.value })
              }
              className="h-8 w-full text-xs rounded-md bg-card border border-border/40 shadow-sm px-2 focus:bg-card focus:border-primary/50 focus:ring-2 focus:ring-primary/20 transition-all outline-none"
            >
              <option value="">{t("todoRecurrenceNone")}</option>
              <option value="daily">{t("todoRecurrenceDaily")}</option>
              <option value="weekly">{t("todoRecurrenceWeekly")}</option>
              <option value="monthly">{t("todoRecurrenceMonthly")}</option>
            </select>
          </PropertyRow>

          {/* 标签 - chip 列表 */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
              {t("todoTags")}
            </label>
            <div className="flex flex-wrap items-center gap-1.5">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 bg-muted rounded-md px-2 py-0.5 text-xs"
                >
                  {tag}
                  <button
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
                className="flex-1 min-w-[60px] h-6 text-xs bg-transparent border-none outline-none placeholder:text-muted-foreground/40"
              />
            </div>
          </div>

          {/* 描述 */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                {t("todoDescription")}
              </label>
              <span className="text-[9px] bg-muted/40 text-muted-foreground px-1.5 py-0.5 rounded">
                Markdown
              </span>
            </div>
            <textarea
              value={form.description}
              onChange={(e) =>
                onChange({ ...form, description: e.target.value })
              }
              className="w-full min-h-[120px] p-3 rounded-xl bg-muted/30 border border-border/30 shadow-sm text-sm font-mono
                         focus:ring-2 focus:ring-primary/20
                         transition-all outline-none resize-y placeholder:text-muted-foreground/40"
              placeholder={t("todoDescPlaceholder")}
              spellCheck={false}
            />
          </div>

          {/* 子任务 - 仅编辑模式显示 */}
          {!isNew && (
            <div className="space-y-1.5">
              <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                {t("todoSubtasks")}
              </label>
              <TodoSubtaskList
                subtasks={subtasks}
                onToggle={onToggleSubtask}
                onDelete={onDeleteSubtask}
                onAdd={onAddSubtask}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

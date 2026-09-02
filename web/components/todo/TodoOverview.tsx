import { useTranslation } from "react-i18next";
import {
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleDashed,
  Flag,
  ListTodo,
  Sun,
  Target,
} from "lucide-react";
import type { TodoItem, TodoPriority, TodoStatus } from "@/types";

interface TodoOverviewProps {
  todos: TodoItem[];
  onSelectTodo: (todo: TodoItem) => void;
  onToggleStatus?: (todo: TodoItem) => void;
}

const PRIORITY_ORDER: Record<TodoPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

const PRIORITY_STYLES: Record<TodoPriority, string> = {
  high: "text-[var(--app-status-danger)]",
  medium: "text-[var(--app-status-warning)]",
  low: "text-[var(--app-text-tertiary)]",
};

function isOverdue(todo: TodoItem) {
  return Boolean(
    todo.dueDate
      && todo.status !== "done"
      && new Date(todo.dueDate).getTime() < Date.now(),
  );
}

function focusRank(todo: TodoItem) {
  if (todo.status === "in_progress") return 0;
  if (isOverdue(todo)) return 1;
  if (todo.myDay) return 2;
  return 3;
}

function compareFocusTodos(a: TodoItem, b: TodoItem) {
  const rankDifference = focusRank(a) - focusRank(b);
  if (rankDifference !== 0) return rankDifference;

  const priorityDifference = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
  if (priorityDifference !== 0) return priorityDifference;

  const aDue = a.dueDate ? new Date(a.dueDate).getTime() : Number.POSITIVE_INFINITY;
  const bDue = b.dueDate ? new Date(b.dueDate).getTime() : Number.POSITIVE_INFINITY;
  if (aDue !== bDue) return aDue - bDue;

  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

function formatDate(value: string, locale: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
  }).format(date);
}

function StatusIcon({ status, size = 18 }: { status: TodoStatus; size?: number }) {
  if (status === "in_progress") {
    return <CircleDashed size={size} className="text-[var(--app-accent)]" />;
  }
  if (status === "done") {
    return <CheckCircle2 size={size} className="text-[var(--app-status-success)]" />;
  }
  return <Circle size={size} className="text-muted-foreground" />;
}

function PriorityLabel({ priority }: { priority: TodoPriority }) {
  const { t } = useTranslation("dialogs");
  const labels: Record<TodoPriority, string> = {
    high: t("todoPriorityHigh"),
    medium: t("todoPriorityMedium"),
    low: t("todoPriorityLow"),
  };

  return (
    <span className={`inline-flex items-center gap-1 ${PRIORITY_STYLES[priority]}`}>
      <Flag size={11} />
      {labels[priority]}
    </span>
  );
}

function FocusTask({
  todo,
  onSelect,
  onToggleStatus,
}: {
  todo: TodoItem;
  onSelect: () => void;
  onToggleStatus?: () => void;
}) {
  const { t, i18n } = useTranslation("dialogs");
  const completedSubtasks = todo.subtasks.filter((subtask) => subtask.completed).length;

  return (
    <article className="rounded-md border border-border/55 bg-card/25 transition-colors duration-[var(--dur-fast)] hover:border-border">
      <div className="flex min-w-0 items-start gap-3.5 p-5">
        <button
          type="button"
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-sm transition-colors hover:bg-[var(--app-hover)]"
          onClick={onToggleStatus}
          disabled={!onToggleStatus}
          aria-label={t("todoToggleStatus")}
        >
          <StatusIcon status={todo.status} size={20} />
        </button>

        <button type="button" className="min-w-0 flex-1 text-left" onClick={onSelect}>
          <span data-testid="todo-overview-focus-title" className="block truncate text-base font-semibold text-foreground">
            {todo.title}
          </span>
          {todo.description && (
            <span className="mt-1.5 block max-h-10 overflow-hidden text-[13px] leading-5 text-muted-foreground">
              {todo.description}
            </span>
          )}
          <span className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
            <PriorityLabel priority={todo.priority} />
            {todo.myDay && (
              <span className="inline-flex items-center gap-1 text-[var(--app-status-warning)]">
                <Sun size={11} />
                {t("todoMyDay")}
              </span>
            )}
            {todo.dueDate && (
              <span className={`inline-flex items-center gap-1 ${isOverdue(todo) ? "text-[var(--app-status-danger)]" : ""}`}>
                <CalendarDays size={11} />
                {formatDate(todo.dueDate, i18n.language)}
              </span>
            )}
            {todo.subtasks.length > 0 && (
              <span>
                {t("todoOverviewSubtaskProgress", {
                  completed: completedSubtasks,
                  total: todo.subtasks.length,
                })}
              </span>
            )}
          </span>
        </button>

        <button
          type="button"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-[var(--app-hover)] hover:text-foreground"
          onClick={onSelect}
          aria-label={t("todoDetail")}
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </article>
  );
}

function CompactTaskRow({
  todo,
  onSelect,
  onToggleStatus,
}: {
  todo: TodoItem;
  onSelect: () => void;
  onToggleStatus?: () => void;
}) {
  const { t, i18n } = useTranslation("dialogs");

  return (
    <div className="group flex min-h-11 items-center border-b border-border/35 last:border-b-0">
      <button
        type="button"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm transition-colors hover:bg-[var(--app-hover)]"
        onClick={onToggleStatus}
        disabled={!onToggleStatus}
        aria-label={t("todoToggleStatus")}
      >
        <StatusIcon status={todo.status} size={16} />
      </button>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-3 py-2 pr-1 text-left" onClick={onSelect}>
        <span
          data-testid="todo-overview-task-title"
          className={`min-w-0 flex-1 truncate text-[13px] font-medium ${
            todo.status === "done" ? "text-muted-foreground line-through" : "text-foreground"
          }`}
        >
          {todo.title}
        </span>
        <span className="flex shrink-0 items-center gap-3 text-[11px] text-muted-foreground">
          <PriorityLabel priority={todo.priority} />
          {todo.dueDate && <span>{formatDate(todo.dueDate, i18n.language)}</span>}
          <ChevronRight size={13} className="text-muted-foreground/45" />
        </span>
      </button>
    </div>
  );
}

export default function TodoOverview({
  todos,
  onSelectTodo,
  onToggleStatus,
}: TodoOverviewProps) {
  const { t } = useTranslation("dialogs");
  const todoCount = todos.filter((todo) => todo.status === "todo").length;
  const inProgressCount = todos.filter((todo) => todo.status === "in_progress").length;
  const doneCount = todos.filter((todo) => todo.status === "done").length;
  const openCount = todoCount + inProgressCount;
  const completionRate = todos.length > 0 ? Math.round((doneCount / todos.length) * 100) : 0;
  const openTodos = todos.filter((todo) => todo.status !== "done").sort(compareFocusTodos);
  const focusTodo = openTodos[0] ?? [...todos]
    .filter((todo) => todo.status === "done")
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
  const otherTodos = [...todos]
    .filter((todo) => todo.id !== focusTodo?.id)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 6);

  return (
    <div className="@container/overview flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center border-b border-border/35 px-5">
        <h2 className="text-[13px] font-semibold">{t("todoOverviewTitle")}</h2>
        <span className="ml-3 border-l border-border/50 pl-3 text-xs text-muted-foreground">
          {t("todoOverviewOpenCount", { count: openCount })}
        </span>
      </header>

      {todos.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
          <ListTodo size={24} strokeWidth={1.4} />
          <p className="text-sm">{t("noTasks")}</p>
        </div>
      ) : (
          <div className="app-scrollbar flex-1 overflow-y-auto">
          <div className="w-full max-w-[1120px] px-6 py-6">
            <div className="grid gap-6 @min-[800px]/overview:grid-cols-[minmax(420px,1fr)_260px]">
              {focusTodo && (
                <section>
                  <div className="mb-3 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <Target size={14} className="text-[var(--app-accent)]" />
                    <h3>{openCount > 0 ? t("todoOverviewFocus") : t("todoOverviewCompleted")}</h3>
                  </div>
                  <FocusTask
                    todo={focusTodo}
                    onSelect={() => onSelectTodo(focusTodo)}
                    onToggleStatus={onToggleStatus ? () => onToggleStatus(focusTodo) : undefined}
                  />
                </section>
              )}

              <section className="border-t border-border/40 pt-6 @min-[800px]/overview:border-l @min-[800px]/overview:border-t-0 @min-[800px]/overview:pl-6 @min-[800px]/overview:pt-0">
                <div className="max-w-[220px]">
                  <div className="flex h-7 items-center gap-2">
                    <h3 className="text-xs font-medium text-muted-foreground">{t("todoOverviewProgress")}</h3>
                    <span className="text-xs font-semibold tabular-nums text-foreground/80">{completionRate}%</span>
                  </div>
                  <div
                    className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-muted/60"
                    role="progressbar"
                    aria-label={t("todoOverviewCompletion")}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={completionRate}
                  >
                    <span className="bg-[var(--app-accent)]" style={{ width: `${(inProgressCount / todos.length) * 100}%` }} />
                    <span className="bg-[var(--app-status-success)]" style={{ width: `${(doneCount / todos.length) * 100}%` }} />
                  </div>
                  <div className="mt-3 divide-y divide-border/35">
                    <div className="grid h-9 grid-cols-[16px_72px_28px] items-center gap-2">
                      <Circle size={13} className="text-muted-foreground" />
                      <span className="text-xs text-muted-foreground">{t("todoTodo")}</span>
                      <strong className="justify-self-end text-sm font-semibold tabular-nums">{todoCount}</strong>
                    </div>
                    <div className="grid h-9 grid-cols-[16px_72px_28px] items-center gap-2">
                      <CircleDashed size={13} className="text-[var(--app-accent)]" />
                      <span className="text-xs text-muted-foreground">{t("todoInProgress")}</span>
                      <strong className="justify-self-end text-sm font-semibold tabular-nums">{inProgressCount}</strong>
                    </div>
                    <div className="grid h-9 grid-cols-[16px_72px_28px] items-center gap-2">
                      <CheckCircle2 size={13} className="text-[var(--app-status-success)]" />
                      <span className="text-xs text-muted-foreground">{t("todoDone")}</span>
                      <strong className="justify-self-end text-sm font-semibold tabular-nums">{doneCount}</strong>
                    </div>
                  </div>
                </div>
              </section>
            </div>

            {otherTodos.length > 0 && (
              <section className="mt-8 border-t border-border/40 pt-6">
                <div className="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <ListTodo size={13} />
                  <h3>{t("todoOverviewOther")}</h3>
                  <span className="text-muted-foreground/60">{otherTodos.length}</span>
                </div>
                <div>
                  {otherTodos.map((todo) => (
                    <CompactTaskRow
                      key={todo.id}
                      todo={todo}
                      onSelect={() => onSelectTodo(todo)}
                      onToggleStatus={onToggleStatus ? () => onToggleStatus(todo) : undefined}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

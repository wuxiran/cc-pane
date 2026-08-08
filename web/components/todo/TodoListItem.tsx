import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Circle,
  CheckCircle2,
  CircleDashed,
  Flag,
  Calendar,
  CheckSquare,
  GripVertical,
  Trash2,
  Sun,
} from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { TodoItem } from "@/types";

interface TodoListItemProps {
  todo: TodoItem;
  isSelected: boolean;
  onSelect: () => void;
  onToggleStatus: () => void;
  onTogglePriority?: () => void;
  onToggleMyDay?: () => void;
  selectionMode?: boolean;
  isMultiSelected?: boolean;
  onToggleSelect?: () => void;
  dragDisabled?: boolean;
}

const PRIORITY_FLAG_STYLE = {
  high: "text-[var(--app-status-danger)] fill-[color-mix(in_srgb,var(--app-status-danger)_20%,transparent)]",
  medium: "text-[var(--app-status-warning)] fill-[color-mix(in_srgb,var(--app-status-warning)_20%,transparent)]",
  low: "text-[var(--app-text-tertiary)]",
};

export default function TodoListItem({
  todo,
  isSelected,
  onSelect,
  onToggleStatus,
  onTogglePriority,
  onToggleMyDay,
  selectionMode = false,
  isMultiSelected = false,
  onToggleSelect,
}: TodoListItemProps) {
  const { t } = useTranslation("dialogs");
  const completedSubtasks = todo.subtasks.filter((s) => s.completed).length;
  const totalSubtasks = todo.subtasks.length;
  const metadataTags = todo.tags.filter(
    (tag) => tag.trim() && tag.trim() !== todo.title.trim(),
  );
  const visibleTags = metadataTags.slice(0, 2);
  const isOverdue =
    todo.dueDate &&
    todo.status !== "done" &&
    new Date(todo.dueDate) < new Date();

  const statusIcon =
    todo.status === "done" ? (
      <CheckCircle2 className="h-[18px] w-[18px] text-[var(--app-status-success)]" />
    ) : todo.status === "in_progress" ? (
      <CircleDashed className="h-[18px] w-[18px] text-[var(--app-accent)]" />
    ) : (
      <Circle className="h-[18px] w-[18px] text-muted-foreground transition-colors hover:text-primary" />
    );

  return (
    <div
      className={`group relative mx-1 flex min-h-10 cursor-pointer items-center gap-2.5 rounded-sm border-b border-border/40 px-2 py-1.5 pr-10
        transition-colors duration-[var(--dur-fast)]
        ${
          isSelected
            ? "bg-primary/10"
            : "hover:bg-accent/40"
        }`}
      onClick={selectionMode && onToggleSelect ? onToggleSelect : onSelect}
    >
      {selectionMode && onToggleSelect && (
        <button
          type="button"
          aria-label={isMultiSelected ? t("todoDeselect") : t("todoSelect")}
          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
            isMultiSelected ? "border-primary bg-primary text-primary-foreground" : "border-input hover:border-primary"
          }`}
          onClick={(event) => {
            event.stopPropagation();
            onToggleSelect();
          }}
        >
          {isMultiSelected && <span className="text-[10px]">✓</span>}
        </button>
      )}
      {/* 状态切换 */}
      <button
        className="shrink-0 transition-transform active:scale-90"
        onClick={(e) => {
          e.stopPropagation();
          onToggleStatus();
        }}
        title={t("todoToggleStatus")}
      >
        {statusIcon}
      </button>

      {/* 内容 */}
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <span
          className={`min-w-0 flex-1 truncate text-sm font-medium transition-colors duration-[var(--dur-fast)] ${
            todo.status === "done"
              ? "line-through text-muted-foreground/50"
              : "text-foreground"
          }`}
        >
          {todo.title}
        </span>

        <div className="flex max-w-[55%] shrink-0 items-center gap-2 overflow-hidden">
          {/* 类型 badge */}
          {todo.todoType && (
            <Badge
              variant="outline"
              className="text-xs px-1.5 py-0 h-4 font-medium border-primary/30 text-primary"
            >
              {todo.todoType}
            </Badge>
          )}
          {/* Tags */}
          {visibleTags.map((tag) => (
            <Badge
              key={tag}
              variant="secondary"
              className="text-xs px-1.5 py-0 h-4 font-medium"
            >
              {tag}
            </Badge>
          ))}
          {metadataTags.length > visibleTags.length && (
            <span className="text-xs text-muted-foreground bg-secondary/50 px-1 rounded">
              +{metadataTags.length - visibleTags.length}
            </span>
          )}

          {/* 子任务进度 */}
          {totalSubtasks > 0 && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <CheckSquare size={9} />
              {completedSubtasks}/{totalSubtasks}
            </span>
          )}

          {/* 到期日 */}
          {todo.dueDate && (
            <span
              className={`flex items-center gap-0.5 text-xs ${
                isOverdue ? "text-[var(--app-status-danger)] font-medium" : "text-muted-foreground"
              }`}
            >
              <Calendar size={9} />
              {new Date(todo.dueDate).toLocaleDateString()}
            </span>
          )}
        </div>

        {onToggleMyDay && (
          <button
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded opacity-0 transition-[opacity,background-color] hover:bg-muted group-hover:opacity-100 ${
              todo.myDay ? "!opacity-100" : ""
            }`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleMyDay();
            }}
            title={todo.myDay ? t("todoRemoveFromMyDay") : t("todoAddToMyDay")}
          >
            <Sun
              className={`h-3.5 w-3.5 transition-colors ${
                todo.myDay
                  ? "fill-[color-mix(in_srgb,var(--app-status-warning)_30%,transparent)] text-[var(--app-status-warning)]"
                  : "text-muted-foreground hover:text-[var(--app-status-warning)]"
              }`}
            />
          </button>
        )}
        <button
          type="button"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors hover:bg-muted"
          onClick={(event) => {
            event.stopPropagation();
            onTogglePriority?.();
          }}
          title={t("todoTogglePriority")}
        >
          <Flag className={`h-3.5 w-3.5 ${PRIORITY_FLAG_STYLE[todo.priority]}`} />
        </button>
      </div>
    </div>
  );
}

// ============ Sortable 包装器（用于拖拽排序） ============

interface SortableTodoListItemProps {
  todo: TodoItem;
  isSelected: boolean;
  onSelect: () => void;
  onToggleStatus: () => void;
  onTogglePriority?: () => void;
  onToggleMyDay?: () => void;
  onDelete: (id: string) => void;
  selectionMode?: boolean;
  isMultiSelected?: boolean;
  onToggleSelect?: () => void;
  dragDisabled?: boolean;
}

export function SortableTodoListItem({
  todo,
  isSelected,
  onSelect,
  onToggleStatus,
  onTogglePriority,
  onToggleMyDay,
  onDelete,
  selectionMode,
  isMultiSelected,
  onToggleSelect,
  dragDisabled = false,
}: SortableTodoListItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: todo.id, disabled: dragDisabled });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="group/sortable relative flex items-center">
      {/* 拖拽手柄 */}
      {!dragDisabled && (
        <button
          className="shrink-0 w-5 flex items-center justify-center cursor-grab opacity-0 group-hover/sortable:opacity-60 focus-visible:opacity-100 transition-opacity"
          {...attributes}
          {...listeners}
          title="Drag to reorder"
        >
          <GripVertical className="w-3 h-3 text-muted-foreground" />
        </button>
      )}

      {/* TodoListItem */}
      <div className="flex-1 min-w-0">
        <TodoListItem
          todo={todo}
          isSelected={isSelected}
          onSelect={onSelect}
          onToggleStatus={onToggleStatus}
          onTogglePriority={onTogglePriority}
          onToggleMyDay={onToggleMyDay}
          selectionMode={selectionMode}
          isMultiSelected={isMultiSelected}
          onToggleSelect={onToggleSelect}
        />
      </div>

      {/* 删除按钮 */}
      <div className="absolute right-2 top-1/2 flex -translate-y-1/2 opacity-0 transition-opacity duration-[var(--dur-fast)] group-hover/sortable:opacity-100 focus-within:opacity-100">
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(todo.id);
          }}
        >
          <Trash2 size={12} />
        </Button>
      </div>
    </div>
  );
}

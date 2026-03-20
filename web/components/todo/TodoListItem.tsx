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
  onToggleMyDay?: () => void;
}

const PRIORITY_FLAG_STYLE = {
  high: "text-rose-500 fill-rose-500/20",
  medium: "text-amber-500 fill-amber-500/20",
  low: "text-slate-400",
};

export default function TodoListItem({
  todo,
  isSelected,
  onSelect,
  onToggleStatus,
  onToggleMyDay,
}: TodoListItemProps) {
  const { t } = useTranslation("dialogs");
  const completedSubtasks = todo.subtasks.filter((s) => s.completed).length;
  const totalSubtasks = todo.subtasks.length;
  const isOverdue =
    todo.dueDate &&
    todo.status !== "done" &&
    new Date(todo.dueDate) < new Date();

  const statusIcon =
    todo.status === "done" ? (
      <CheckCircle2 className="w-5 h-5 text-emerald-500" />
    ) : todo.status === "in_progress" ? (
      <CircleDashed className="w-5 h-5 text-blue-500 animate-[spin_4s_linear_infinite]" />
    ) : (
      <Circle className="w-5 h-5 text-muted-foreground hover:text-primary transition-colors" />
    );

  return (
    <div
      className={`group relative flex items-start gap-2.5 p-4 cursor-pointer rounded-2xl mx-2 my-1
        transition-all duration-200 ease-out border
        ${
          isSelected
            ? "bg-primary/5 border-primary/60 shadow-sm ring-2 ring-primary/10"
            : "bg-card border-border/50 hover:border-primary/30 hover:shadow-md hover:-translate-y-[1px]"
        }`}
      onClick={onSelect}
    >
      {/* 状态切换 */}
      <button
        className="mt-0.5 shrink-0 transition-transform active:scale-90"
        onClick={(e) => {
          e.stopPropagation();
          onToggleStatus();
        }}
        title={t("todoToggleStatus")}
      >
        {statusIcon}
      </button>

      {/* 内容 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span
            className={`text-sm font-medium truncate transition-colors duration-200 ${
              todo.status === "done"
                ? "line-through text-muted-foreground/50"
                : "text-foreground"
            }`}
          >
            {todo.title}
          </span>
          <div className="flex items-center gap-1 shrink-0">
            {/* "我的一天"太阳图标 */}
            {onToggleMyDay && (
              <button
                className={`opacity-0 group-hover:opacity-100 transition-opacity ${
                  todo.myDay ? "!opacity-100" : ""
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleMyDay();
                }}
                title={todo.myDay ? t("todoRemoveFromMyDay") : t("todoAddToMyDay")}
              >
                <Sun
                  className={`w-3.5 h-3.5 transition-colors ${
                    todo.myDay
                      ? "text-amber-500 fill-amber-500/30"
                      : "text-muted-foreground hover:text-amber-500"
                  }`}
                />
              </button>
            )}
            {/* 优先级旗标 */}
            <div className="opacity-80 group-hover:opacity-100 transition-opacity">
              <Flag
                className={`w-3.5 h-3.5 ${PRIORITY_FLAG_STYLE[todo.priority]}`}
              />
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
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
          {todo.tags.slice(0, 3).map((tag) => (
            <Badge
              key={tag}
              variant="secondary"
              className="text-xs px-1.5 py-0 h-4 font-medium"
            >
              {tag}
            </Badge>
          ))}
          {todo.tags.length > 3 && (
            <span className="text-xs text-muted-foreground bg-secondary/50 px-1 rounded">
              +{todo.tags.length - 3}
            </span>
          )}

          {/* 子任务进度 */}
          {totalSubtasks > 0 && (
            <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
              <CheckSquare size={9} />
              {completedSubtasks}/{totalSubtasks}
            </span>
          )}

          {/* 到期日 */}
          {todo.dueDate && (
            <span
              className={`flex items-center gap-0.5 text-xs ${
                isOverdue ? "text-red-500 font-medium" : "text-muted-foreground"
              }`}
            >
              <Calendar size={9} />
              {new Date(todo.dueDate).toLocaleDateString()}
            </span>
          )}
        </div>
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
  onToggleMyDay?: () => void;
  onDelete: (id: string) => void;
}

export function SortableTodoListItem({
  todo,
  isSelected,
  onSelect,
  onToggleStatus,
  onToggleMyDay,
  onDelete,
}: SortableTodoListItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: todo.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="group/sortable relative flex items-center">
      {/* 拖拽手柄 */}
      <button
        className="shrink-0 w-5 flex items-center justify-center cursor-grab opacity-0 group-hover/sortable:opacity-60 transition-opacity"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="w-3 h-3 text-muted-foreground" />
      </button>

      {/* TodoListItem */}
      <div className="flex-1 min-w-0">
        <TodoListItem
          todo={todo}
          isSelected={isSelected}
          onSelect={onSelect}
          onToggleStatus={onToggleStatus}
          onToggleMyDay={onToggleMyDay}
        />
      </div>

      {/* 删除按钮 */}
      <div className="absolute right-3 top-3 hidden group-hover/sortable:flex">
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

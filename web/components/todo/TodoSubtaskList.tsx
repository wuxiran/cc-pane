import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Check, Trash2, ListPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { TodoSubtask } from "@/types";

interface TodoSubtaskListProps {
  subtasks: TodoSubtask[];
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onAdd: (title: string) => void;
}

export default function TodoSubtaskList({
  subtasks,
  onToggle,
  onDelete,
  onAdd,
}: TodoSubtaskListProps) {
  const { t } = useTranslation("dialogs");
  const [newTitle, setNewTitle] = useState("");

  const handleAdd = useCallback(() => {
    if (newTitle.trim()) {
      onAdd(newTitle.trim());
      setNewTitle("");
    }
  }, [newTitle, onAdd]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleAdd();
      }
    },
    [handleAdd]
  );

  const completed = subtasks.filter((s) => s.completed).length;

  return (
    <div className="space-y-2">
      {/* 进度指示 */}
      {subtasks.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {t("todoSubtaskProgress", { completed, total: subtasks.length })}
            </span>
            <span className="text-xs text-muted-foreground">
              {subtasks.length > 0
                ? Math.round((completed / subtasks.length) * 100)
                : 0}
              %
            </span>
          </div>
          {/* 进度条 */}
          <div className="h-1.5 bg-muted/50 rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-300"
              style={{
                width: `${subtasks.length > 0 ? (completed / subtasks.length) * 100 : 0}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* 子任务列表 */}
      <div className="space-y-0.5">
        {subtasks.map((subtask) => (
          <div
            key={subtask.id}
            className="group flex items-center gap-2.5 px-3 py-2 rounded-xl
                       hover:bg-muted/40 hover:shadow-sm transition-all border border-transparent hover:border-border/30"
          >
            {/* 自定义 Checkbox */}
            <button
              onClick={() => onToggle(subtask.id)}
              className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-all duration-200
                ${
                  subtask.completed
                    ? "bg-primary border-primary text-primary-foreground"
                    : "bg-transparent border-input hover:border-primary text-transparent"
                }`}
            >
              <Check strokeWidth={3} className="w-3 h-3" />
            </button>

            {/* 子任务文字 */}
            <span
              className={`flex-1 text-sm transition-all duration-200 ${
                subtask.completed
                  ? "line-through text-muted-foreground/50"
                  : "text-foreground"
              }`}
            >
              {subtask.title}
            </span>

            {/* 悬浮删除按钮 */}
            <Button
              size="icon"
              variant="ghost"
              className="h-5 w-5 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
              onClick={() => onDelete(subtask.id)}
            >
              <Trash2 size={10} />
            </Button>
          </div>
        ))}
      </div>

      {/* 快捷添加 */}
      <div className="flex items-center gap-2 pt-1 border-t border-border/50">
        <ListPlus className="w-4 h-4 text-primary shrink-0" />
        <Input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("todoAddSubtaskPlaceholder")}
          className="h-7 text-xs bg-transparent border-none shadow-none focus-visible:ring-0 placeholder:text-muted-foreground/40"
        />
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 shrink-0"
          onClick={handleAdd}
          disabled={!newTitle.trim()}
        >
          <Plus size={14} />
        </Button>
      </div>
    </div>
  );
}

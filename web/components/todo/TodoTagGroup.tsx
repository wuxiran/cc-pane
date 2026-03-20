import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Trash2 } from "lucide-react";
import * as Collapsible from "@radix-ui/react-collapsible";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import TodoListItem from "./TodoListItem";
import type { TodoItem } from "@/types";

interface TodoTagGroupProps {
  /** 分组键（tag 名、状态值、优先级值、作用域值） */
  tag: string;
  /** 可选的显示标签（已翻译），不提供时使用 tag */
  label?: string;
  todos: TodoItem[];
  defaultOpen?: boolean;
  selectedId?: string;
  onSelect: (todo: TodoItem) => void;
  onToggleStatus: (todo: TodoItem) => void;
  onDelete: (id: string) => void;
}

export default function TodoTagGroup({
  tag,
  label,
  todos,
  defaultOpen = true,
  selectedId,
  onSelect,
  onToggleStatus,
  onDelete,
}: TodoTagGroupProps) {
  const { t } = useTranslation("dialogs");
  const [open, setOpen] = useState(defaultOpen);

  const displayTag = label ?? (tag === "__untagged__" ? t("todoUntagged") : tag);
  const doneCount = todos.filter((td) => td.status === "done").length;

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="mb-1">
      <Collapsible.Trigger asChild>
        <button className="flex items-center gap-2 w-full px-3 py-2 text-xs hover:bg-accent/50 hover:shadow-sm rounded-xl transition-all group">
          <ChevronRight
            size={14}
            className={`text-muted-foreground shrink-0 transition-transform duration-200 ${
              open ? "rotate-90" : ""
            }`}
          />
          <Badge
            variant="secondary"
            className="text-[10px] px-1.5 py-0 h-4 font-medium"
          >
            {displayTag}
          </Badge>
          <span className="text-muted-foreground ml-auto">
            {doneCount}/{todos.length}
          </span>
        </button>
      </Collapsible.Trigger>

      <Collapsible.Content className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
        {todos.map((todo) => (
          <div key={todo.id} className="group/item relative">
            <TodoListItem
              todo={todo}
              isSelected={selectedId === todo.id}
              onSelect={() => onSelect(todo)}
              onToggleStatus={() => onToggleStatus(todo)}
            />
            <div className="absolute right-2 top-2 hidden group-hover/item:flex">
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
        ))}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

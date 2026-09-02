// 启动页的通用偏好下拉（模型/模式共用）：首项「默认」= 跟随引擎、不主动设置。
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface StartPrefItem {
  id: string;
  label: string;
  description?: string;
}

export interface StartPrefDropdownProps {
  items: StartPrefItem[];
  /** null = 默认（跟随引擎）。 */
  currentId: string | null;
  defaultLabel: string;
  onSelect: (id: string | null) => void;
}

export default function StartPrefDropdown({
  items,
  currentId,
  defaultLabel,
  onSelect,
}: StartPrefDropdownProps) {
  if (items.length === 0) return null;
  const current = items.find((item) => item.id === currentId) ?? null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-7 min-w-0 items-center gap-1 rounded-md border border-transparent px-2 text-xs text-[var(--app-text-secondary)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
        >
          <span className="max-w-40 truncate">{current?.label ?? defaultLabel}</span>
          <ChevronDown className="h-3 w-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
        <DropdownMenuItem onSelect={() => onSelect(null)}>
          {defaultLabel}
          {currentId === null ? (
            <span className="ml-auto pl-3 text-[var(--app-accent)]">✓</span>
          ) : null}
        </DropdownMenuItem>
        {items.map((item) => (
          <DropdownMenuItem key={item.id} title={item.description} onSelect={() => onSelect(item.id)}>
            <span className="max-w-64 truncate">{item.label}</span>
            {item.id === currentId ? (
              <span className="ml-auto pl-3 text-[var(--app-accent)]">✓</span>
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

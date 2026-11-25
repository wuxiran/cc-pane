// `/` 命令 · `@` 文件 · `$` 技能 的统一补全菜单（数据与键盘状态在 useComposerSuggestions）。
import { FileText, Sparkles, SquareSlash } from "lucide-react";
import type { ComposerSuggestion } from "./useComposerSuggestions";

const KIND_ICON = {
  command: SquareSlash,
  file: FileText,
  skill: Sparkles,
} as const;

export default function ComposerSuggestionMenu({
  items,
  activeIndex,
  onHover,
  onPick,
}: {
  items: ComposerSuggestion[];
  activeIndex: number;
  onHover: (index: number) => void;
  onPick: (item: ComposerSuggestion) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div
      role="listbox"
      data-testid="composer-suggestions"
      className="flex flex-col overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-overlay)] py-1 shadow-md"
    >
      {items.map((item, index) => {
        const Icon = KIND_ICON[item.kind];
        return (
          <button
            key={item.key}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            className={`flex min-w-0 items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[var(--app-hover)] ${
              index === activeIndex ? "bg-[var(--app-active-bg)]" : ""
            }`}
            onMouseEnter={() => onHover(index)}
            // mousedown 先于 textarea 失焦，选中后焦点仍留在输入框
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(item)}
          >
            <Icon className="size-3.5 shrink-0 text-[var(--app-text-tertiary)]" aria-hidden />
            <span className={`shrink-0 text-xs ${item.kind === "file" ? "" : "font-mono"}`}>{item.label}</span>
            {item.detail ? (
              <span className="min-w-0 truncate text-[length:var(--text-caption)] text-[var(--app-text-tertiary)]">
                {item.detail}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

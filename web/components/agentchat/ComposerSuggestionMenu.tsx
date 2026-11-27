// `/` 命令 · `@` Bot/引擎/文件 · `$` 技能 的统一补全菜单（数据与键盘状态在 useComposerSuggestions）。
import { Fragment } from "react";
import { FileText, Sparkles, SquareSlash } from "lucide-react";
import { useTranslation } from "react-i18next";
import ChatEngineIcon from "./ChatEngineIcon";
import type { ComposerSuggestion, SuggestionKind } from "./useComposerSuggestions";

const KIND_ICON = {
  command: SquareSlash,
  file: FileText,
  skill: Sparkles,
} as const;

const GROUP_LABEL: Partial<Record<SuggestionKind, "agentChatMentionGroupBots" | "agentChatMentionGroupEngines" | "agentChatMentionGroupFiles">> = {
  bot: "agentChatMentionGroupBots",
  engine: "agentChatMentionGroupEngines",
  file: "agentChatMentionGroupFiles",
};

function SuggestionIcon({ item }: { item: ComposerSuggestion }) {
  if (item.kind === "bot") {
    return (
      <span
        aria-hidden
        className="flex size-4 shrink-0 items-center justify-center rounded-full text-[10px] leading-none text-white"
        style={{ background: item.avatar?.color || "var(--app-accent)" }}
      >
        {item.avatar?.glyph ?? "?"}
      </span>
    );
  }
  if (item.kind === "engine") {
    const engineId = item.mention?.kind === "engine" ? item.mention.engineId : undefined;
    return <ChatEngineIcon engineId={engineId} className="size-3.5 text-[var(--app-text-tertiary)]" />;
  }
  const Icon = KIND_ICON[item.kind];
  return <Icon className="size-3.5 shrink-0 text-[var(--app-text-tertiary)]" aria-hidden />;
}

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
  const { t } = useTranslation("panes");
  if (items.length === 0) return null;
  // 只有 `@` 混排了 Bot / 引擎时才分组加标题；纯文件 / 命令 / 技能列表保持原样。
  const grouped = items.some((item) => item.kind === "bot" || item.kind === "engine");
  return (
    <div
      role="listbox"
      data-testid="composer-suggestions"
      className="flex max-h-80 flex-col overflow-y-auto rounded-2xl border border-[var(--app-border)] bg-[var(--app-overlay)] py-1 shadow-md"
    >
      {items.map((item, index) => {
        const groupLabel = grouped && items[index - 1]?.kind !== item.kind ? GROUP_LABEL[item.kind] : undefined;
        return (
          <Fragment key={item.key}>
            {groupLabel ? (
              <div
                role="presentation"
                data-testid="composer-suggestion-group"
                className="px-3 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--app-text-tertiary)]"
              >
                {t(groupLabel)}
              </div>
            ) : null}
            <button
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              data-suggestion-kind={item.kind}
              className={`flex min-w-0 items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[var(--app-hover)] ${
                index === activeIndex ? "bg-[var(--app-active-bg)]" : ""
              }`}
              onMouseEnter={() => onHover(index)}
              // mousedown 先于 textarea 失焦，选中后焦点仍留在输入框
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(item)}
            >
              <SuggestionIcon item={item} />
              <span className={`shrink-0 text-xs ${item.kind === "command" || item.kind === "skill" ? "font-mono" : ""}`}>{item.label}</span>
              {item.detail ? (
                <span className="min-w-0 truncate text-[length:var(--text-caption)] text-[var(--app-text-tertiary)]">
                  {item.detail}
                </span>
              ) : null}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}

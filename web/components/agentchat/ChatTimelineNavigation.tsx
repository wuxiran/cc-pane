import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Bookmark } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { useChatTimelineStore } from "@/stores/useChatTimelineStore";
import type { ChatTurn } from "./chatTurns";
import { buildChatTimeline, type ChatTimelineEntry } from "./chatTimeline";
import { useChatTimelineNavigation } from "./useChatTimelineNavigation";

interface Props {
  conversationKey: string;
  turns: ChatTurn[];
  scrollRef: RefObject<HTMLDivElement | null>;
  visibleCount: number;
  onReveal: (turnIndex: number) => void;
  onNavigate: () => void;
}

const NO_BOOKMARKS: string[] = [];

export default function ChatTimelineNavigation({ conversationKey, turns, ...navigation }: Props) {
  const { t } = useTranslation("panes");
  const entries = useMemo(() => buildChatTimeline(turns), [turns]);
  const { activeId, jumpToEntry } = useChatTimelineNavigation({ entries, ...navigation });
  const bookmarks = useChatTimelineStore((state) => state.bookmarks[conversationKey] ?? NO_BOOKMARKS);
  const toggle = useChatTimelineStore((state) => state.toggleBookmark);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const suppressFocusPreview = useRef(false);
  const activeIndex = entries.findIndex((entry) => entry.id === activeId);

  function keepOpen() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }
  function closeSoon() {
    keepOpen();
    closeTimer.current = setTimeout(() => setPreviewId(null), 180);
  }
  function jump(entry: ChatTimelineEntry) {
    keepOpen();
    setPreviewId(null);
    jumpToEntry(entry);
  }
  function moveFocus(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const keys: Record<string, number> = {
      ArrowUp: Math.max(0, index - 1), ArrowDown: Math.min(entries.length - 1, index + 1),
      Home: 0, End: entries.length - 1,
    };
    const next = keys[event.key];
    if (next === undefined) return;
    event.preventDefault();
    navRef.current?.querySelectorAll<HTMLButtonElement>("[data-timeline-entry]")[next]?.focus();
  }

  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  useEffect(() => {
    const nav = navRef.current;
    const current = Array.from(nav?.querySelectorAll<HTMLElement>("[data-timeline-entry]") ?? [])
      .find((element) => element.dataset.timelineEntry === activeId);
    if (!nav || !current || previewId || nav.contains(document.activeElement)) return;
    const rail = nav.getBoundingClientRect();
    const marker = current.getBoundingClientRect();
    if (marker.top < rail.top) nav.scrollTop -= rail.top - marker.top;
    else if (marker.bottom > rail.bottom) nav.scrollTop += marker.bottom - rail.bottom;
  }, [activeId, previewId]);

  if (!entries.length) return null;
  return (
    <div className="agent-chat-timeline-rail pointer-events-none absolute inset-y-0 left-0 z-10 flex w-12 items-center justify-center py-4">
      <nav
        ref={navRef}
        aria-label={t("agentChatTimeline")}
        className="pointer-events-auto max-h-full w-11 overflow-y-auto overscroll-contain py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {entries.map((entry, index) => {
          const saved = bookmarks.includes(entry.bookmarkKey);
          const title = entry.title || t("agentChatTimelineUntitled");
          const distance = Math.abs(index - activeIndex);
          return (
            <Popover key={entry.id} open={previewId === entry.id} onOpenChange={(open) => {
              keepOpen();
              setPreviewId((current) => open ? entry.id : current === entry.id ? null : current);
            }}>
              <PopoverAnchor asChild>
                <button
                  type="button"
                  data-timeline-entry={entry.id}
                  aria-label={t("agentChatTimelineJump", { number: index + 1, title })}
                  aria-current={entry.id === activeId ? "step" : undefined}
                  aria-expanded={previewId === entry.id}
                  aria-haspopup="dialog"
                  tabIndex={entry.id === (focusedId ?? activeId) ? 0 : -1}
                  className="group relative flex h-5 w-10 items-center justify-start rounded px-2 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--app-accent)]"
                  onPointerEnter={() => { keepOpen(); setPreviewId(entry.id); }}
                  onPointerLeave={closeSoon}
                  onFocus={() => {
                    keepOpen();
                    setFocusedId(entry.id);
                    if (suppressFocusPreview.current) suppressFocusPreview.current = false;
                    else setPreviewId(entry.id);
                  }}
                  onBlur={(event) => {
                    if (!(event.relatedTarget instanceof Element && event.relatedTarget.closest("[data-chat-timeline-preview]"))) closeSoon();
                  }}
                  onKeyDown={(event) => moveFocus(event, index)}
                  onClick={() => jump(entry)}
                >
                  <span
                    aria-hidden="true"
                    style={{ width: Math.max(10, 28 - distance * 5) }}
                    className={`h-0.5 shrink-0 rounded-full transition-[width,background-color] motion-reduce:transition-none ${
                      entry.id === activeId ? "bg-[var(--app-text-primary)]"
                        : saved ? "bg-[var(--app-accent)]" : "bg-[var(--app-text-tertiary)] opacity-50 group-hover:opacity-100"
                    }`}
                  />
                  {saved ? <span aria-hidden="true" className="absolute right-0.5 h-1 w-1 rounded-full bg-[var(--app-accent)]" /> : null}
                </button>
              </PopoverAnchor>
              <PopoverContent
                side="right"
                align="center"
                sideOffset={8}
                collisionPadding={12}
                data-chat-timeline-preview=""
                aria-label={t("agentChatTimelinePreview", { number: index + 1 })}
                className="w-80 max-w-[calc(100vw-4rem)] rounded-xl border-[var(--app-border)] bg-[var(--app-panel-bg)] p-3 text-[var(--app-text-primary)] shadow-xl"
                onOpenAutoFocus={(event) => event.preventDefault()}
                onCloseAutoFocus={(event) => event.preventDefault()}
                onEscapeKeyDown={() => {
                  const marker = Array.from(navRef.current?.querySelectorAll<HTMLButtonElement>("[data-timeline-entry]") ?? [])
                    .find((element) => element.dataset.timelineEntry === entry.id);
                  if (marker && document.activeElement !== marker) {
                    suppressFocusPreview.current = true;
                    marker.focus({ preventScroll: true });
                  }
                }}
                onPointerEnter={keepOpen}
                onPointerLeave={closeSoon}
                onFocusCapture={keepOpen}
                onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) closeSoon(); }}
              >
                <div className="flex items-start gap-2">
                  <button type="button" className="min-w-0 flex-1 text-left text-[13px] font-medium leading-5 outline-none focus-visible:underline" onClick={() => jump(entry)}>
                    <span className="line-clamp-2 break-words">{title}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={t(saved ? "agentChatTimelineUnbookmark" : "agentChatTimelineBookmark")}
                    aria-pressed={saved}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--app-text-tertiary)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--app-accent)]"
                    onClick={() => toggle(conversationKey, entry.bookmarkKey)}
                  >
                    <Bookmark className={`h-3.5 w-3.5 ${saved ? "fill-current text-[var(--app-accent)]" : ""}`} />
                  </button>
                </div>
                <p className="mt-1.5 line-clamp-4 break-words text-xs leading-5 text-[var(--app-text-secondary)]">
                  {entry.preview || t("agentChatTimelineNoReply")}
                </p>
                <div className="mt-2 text-[10px] tabular-nums text-[var(--app-text-tertiary)]">
                  {t("agentChatTimelinePosition", { number: index + 1, total: entries.length })}
                </div>
              </PopoverContent>
            </Popover>
          );
        })}
      </nav>
    </div>
  );
}

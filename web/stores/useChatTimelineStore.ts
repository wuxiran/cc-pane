import { create } from "zustand";
import { persist } from "zustand/middleware";

interface ChatTimelineState {
  bookmarks: Record<string, string[]>;
  toggleBookmark: (conversation: string, key: string) => void;
}

/** UI metadata only: no transcript text or attachment data is persisted here. */
export const useChatTimelineStore = create<ChatTimelineState>()(
  persist(
    (set) => ({
      bookmarks: {},
      toggleBookmark: (conversation, key) => set((state) => {
        const previous = state.bookmarks[conversation] ?? [];
        const next = previous.includes(key) ? previous.filter((value) => value !== key) : [...previous, key];
        const bookmarks = { ...state.bookmarks };
        if (next.length) bookmarks[conversation] = next;
        else delete bookmarks[conversation];
        return { bookmarks };
      }),
    }),
    { name: "cc-panes-chat-timeline", partialize: (state) => ({ bookmarks: state.bookmarks }) },
  ),
);

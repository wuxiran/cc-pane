// 侧栏「最近」会话列表的个人偏好：置顶、从列表移除、自己起的名字。
// 只是本机的显示偏好（localStorage），不改 CLI 的转录文件，也不动后端历史。
// key 是会话 key：终端会话 `s:<sessionId>`，Agent 对话 `c:<acpSessionId>`。
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface RecentSessionPrefsState {
  pinned: string[];
  hidden: string[];
  titles: Record<string, string>;
  togglePin: (key: string) => void;
  hide: (key: string) => void;
  /** 空标题 = 恢复成自动取的标题 */
  rename: (key: string, title: string) => void;
}

export const useRecentSessionPrefsStore = create<RecentSessionPrefsState>()(
  persist(
    (set) => ({
      pinned: [],
      hidden: [],
      titles: {},
      togglePin: (key) => set((state) => ({
        pinned: state.pinned.includes(key) ? state.pinned.filter((item) => item !== key) : [key, ...state.pinned],
      })),
      hide: (key) => set((state) => ({
        hidden: state.hidden.includes(key) ? state.hidden : [...state.hidden, key],
        pinned: state.pinned.filter((item) => item !== key),
      })),
      rename: (key, title) => set((state) => {
        const titles = { ...state.titles };
        const trimmed = title.trim();
        if (trimmed) titles[key] = trimmed;
        else delete titles[key];
        return { titles };
      }),
    }),
    { name: "cc-panes-recent-session-prefs", version: 1 },
  ),
);

/** 套用偏好：去掉已移除的、换上自己起的名字、置顶的排最前（其余保持原顺序），再截断。 */
export function applyRecentSessionPrefs<T extends { key: string; title: string }>(
  sessions: readonly T[],
  prefs: Pick<RecentSessionPrefsState, "pinned" | "hidden" | "titles">,
  limit: number,
): T[] {
  const hidden = new Set(prefs.hidden);
  const pinned = new Set(prefs.pinned);
  const visible = sessions
    .filter((session) => !hidden.has(session.key))
    .map((session) => (prefs.titles[session.key] ? { ...session, title: prefs.titles[session.key] } : session));
  const top = visible.filter((session) => pinned.has(session.key));
  const rest = visible.filter((session) => !pinned.has(session.key));
  // 置顶的不占名额，否则置顶多了会把最近的挤没。
  return [...top, ...rest.slice(0, limit)];
}

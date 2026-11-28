// 任务球列表的手动置顶：会话 id 有序列表，存在任务球窗口自己的 localStorage
// （会话 id 只在本次运行有意义，不进设置文件）。
import { useCallback, useState } from "react";

export const ORB_PINNED_STORAGE_KEY = "ccchan.orb.pinned";

export function readPinned(): string[] {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(ORB_PINNED_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function togglePinned(pinned: readonly string[], sessionId: string): string[] {
  return pinned.includes(sessionId) ? pinned.filter((id) => id !== sessionId) : [...pinned, sessionId];
}

export function useOrbPinned(): [string[], (sessionId: string) => void] {
  const [pinned, setPinned] = useState<string[]>(readPinned);
  const toggle = useCallback((sessionId: string) => {
    setPinned((current) => {
      const next = togglePinned(current, sessionId);
      try {
        localStorage.setItem(ORB_PINNED_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // 受限 webview 可能没有可写存储：置顶只在本次窗口内生效。
      }
      return next;
    });
  }, []);
  return [pinned, toggle];
}

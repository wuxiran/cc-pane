// 宠物窗口的会话视图：终端状态（后端事件）+ 主窗口推来的会话目录（标签名、
// 是否正在看）+ 「完成未看」集合。
import { emitTo } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTerminalStatusStore } from "@/stores/useTerminalStatusStore";
import type { TerminalStatusType } from "@/types";
import { listenCCChan } from "./listen";
import { buildSessionEntries, nextReadySet, type SessionPetEntry } from "./petStatus";
import type { SessionDirectoryEntry, SessionDirectoryPayload } from "./types";

export const SESSION_DIRECTORY_EVENT = "ccchan:session-directory";
export const REQUEST_DIRECTORY_EVENT = "ccchan:request-directory";

export function usePetSessions(): {
  entries: SessionPetEntry[];
  directory: ReadonlyMap<string, SessionDirectoryEntry>;
} {
  const statusMap = useTerminalStatusStore((state) => state.statusMap);
  const [directory, setDirectory] = useState<ReadonlyMap<string, SessionDirectoryEntry>>(new Map());
  const [ready, setReady] = useState<ReadonlySet<string>>(new Set());
  const previous = useRef<ReadonlyMap<string, TerminalStatusType>>(new Map());
  const readyRef = useRef<ReadonlySet<string>>(ready);

  useEffect(() => {
    const { init, cleanup } = useTerminalStatusStore.getState();
    void init().catch(() => {});
    return cleanup;
  }, []);

  useEffect(() => {
    const dispose = listenCCChan<SessionDirectoryPayload>(SESSION_DIRECTORY_EVENT, ({ payload }) => {
      const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
      setDirectory(new Map(sessions.map((entry) => [entry.sessionId, entry])));
    }, () => {
      void emitTo("main", REQUEST_DIRECTORY_EVENT).catch(() => {});
    });
    return dispose;
  }, []);

  const viewed = useMemo(
    () => new Set([...directory.values()].filter((entry) => entry.viewed).map((entry) => entry.sessionId)),
    [directory],
  );

  useEffect(() => {
    const current = new Map([...statusMap.values()].map((info) => [info.sessionId, info.status]));
    // 先同步算出下一份再落 state：setState 的 updater 是惰性的，
    // 放进 updater 里读 previous.current 会读到已被覆盖的新值。
    const existing = readyRef.current;
    const next = nextReadySet(previous.current, current, existing, viewed);
    previous.current = current;
    const same = next.size === existing.size && [...next].every((id) => existing.has(id));
    if (!same) {
      readyRef.current = next;
      setReady(next);
    }
  }, [statusMap, viewed]);

  const entries = useMemo(
    () => buildSessionEntries(statusMap.values(), ready, directory),
    [statusMap, ready, directory],
  );
  return { entries, directory };
}

// 启动页（尚未启动会话）的 Tauri 原生文件拖放：落在对话区内时把路径交给附件摄取
// （与会话内输入区同一套附件 chip，首条消息随 startConfiguredChat 一起带上）。
// 命中判定同终端/会话输入区：elementFromPoint 落在本对话区（data-agent-chat-drop-zone）
// 内才处理，其他窗格不受影响。
import { useEffect, useRef, type RefObject } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useTranslation } from "react-i18next";
import { isTauriRuntime } from "@/services/runtime";
import { isDropInsideTerminalHost } from "@/components/panes/terminalDrop";

/** 去重：已是附件、或同批/在途（图片读取是异步的）的路径不再摄取。 */
export function freshDroppedPaths(known: Iterable<string>, paths: readonly string[]): string[] {
  const seen = new Set(known);
  const fresh: string[] = [];
  for (const path of paths) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    fresh.push(path);
  }
  return fresh;
}

export function useStartPageFileDrop(
  anchorRef: RefObject<HTMLElement | null>,
  onPaths: (paths: string[]) => void | Promise<void>,
  knownPaths: () => Iterable<string>,
): void {
  const { t } = useTranslation("panes");
  // 在途路径：同一次 drop 被多个监听重复投递时，第一次的异步摄取还没落进附件列表。
  const inFlight = useRef(new Set<string>());
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    const zoneOf = (anchor: HTMLElement) =>
      anchor.closest<HTMLElement>("[data-agent-chat-drop-zone]") ?? anchor;
    const setZoneActive = (zone: HTMLElement, active: boolean) => {
      if (active) {
        zone.dataset.chatDropActive = "true";
        zone.dataset.chatDropLabel = t("agentChatDropToAttach");
      } else {
        delete zone.dataset.chatDropActive;
      }
    };
    const ingest = (paths: string[]) => {
      const fresh = freshDroppedPaths([...knownPaths(), ...inFlight.current], paths);
      if (fresh.length === 0) return;
      fresh.forEach((path) => inFlight.current.add(path));
      void Promise.resolve()
        .then(() => onPaths(fresh))
        .catch(() => {})
        .finally(() => fresh.forEach((path) => inFlight.current.delete(path)));
      requestAnimationFrame(() => anchorRef.current?.focus());
    };
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        const anchor = anchorRef.current;
        if (disposed || !anchor) return;
        const zone = zoneOf(anchor);
        if (payload.type === "enter" || payload.type === "over") {
          setZoneActive(zone, isDropInsideTerminalHost(zone, payload.position));
          return;
        }
        setZoneActive(zone, false);
        if (payload.type !== "drop" || payload.paths.length === 0) return;
        if (!isDropInsideTerminalHost(zone, payload.position)) return;
        ingest(payload.paths);
      })
      .then((unlistenFn) => {
        if (disposed) unlistenFn();
        else unlisten = unlistenFn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
      const anchor = anchorRef.current;
      if (anchor) setZoneActive(zoneOf(anchor), false);
    };
  }, [anchorRef, onPaths, knownPaths, t]);
}

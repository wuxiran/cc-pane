import { useEffect, useMemo, useRef, useState } from "react";
import { emitTo, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Check, Star, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import StatusIndicator from "@/components/StatusIndicator";
import { layoutSwitcherService, type LayoutSwitcherSnapshot } from "@/services/layoutSwitcherService";
import { useTerminalStatusStore } from "@/stores";
import { aggregatePaneStatus } from "@/utils/layoutStatus";
import type { TerminalStatusInfo } from "@/types";

const STATE_EVENT = "layout-switcher:state";
const REQUEST_STATE_EVENT = "layout-switcher:request-state";
const SWITCH_EVENT = "layout-switcher:switch";
const MAX_STATUS_DOTS = 6;

const EMPTY_SNAPSHOT: LayoutSwitcherSnapshot = {
  layouts: [],
  currentLayoutId: "",
};

function PaneStatusDots({
  paneSessionIds,
  statusMap,
}: {
  paneSessionIds: string[][];
  statusMap: Map<string, TerminalStatusInfo>;
}) {
  const paneStatuses = useMemo(
    () => paneSessionIds.map((sessionIds) =>
      aggregatePaneStatus(sessionIds.map((sessionId) => statusMap.get(sessionId)?.status ?? null)),
    ),
    [paneSessionIds, statusMap],
  );
  const visibleStatuses = paneStatuses.slice(0, MAX_STATUS_DOTS);
  const overflow = paneStatuses.length - visibleStatuses.length;

  return (
    <span className="flex shrink-0 items-center gap-[3px]">
      {visibleStatuses.map((status, index) => (
        status ? (
          <StatusIndicator key={index} status={status} size={6} />
        ) : (
          <span
            key={index}
            className="inline-block h-[6px] w-[6px] shrink-0 rounded-full border"
            style={{ borderColor: "var(--app-border)" }}
          />
        )
      ))}
      {overflow > 0 ? (
        <span className="text-[9px] leading-none" style={{ color: "var(--app-text-tertiary)" }}>
          +{overflow}
        </span>
      ) : null}
    </span>
  );
}

export default function LayoutSwitcherWindow() {
  const { t } = useTranslation("panes");
  const statusMap = useTerminalStatusStore((s) => s.statusMap);
  const [snapshot, setSnapshot] = useState<LayoutSwitcherSnapshot>(EMPTY_SNAPSHOT);
  const moveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void useTerminalStatusStore.getState().init();
    return () => {
      if (moveTimerRef.current) {
        clearTimeout(moveTimerRef.current);
      }
      useTerminalStatusStore.getState().cleanup();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlistenState: UnlistenFn | null = null;
    let unlistenMoved: UnlistenFn | null = null;
    const win = getCurrentWindow();

    getCurrentWebview()
      .listen<LayoutSwitcherSnapshot>(STATE_EVENT, (event) => {
        setSnapshot(event.payload);
      })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenState = unlisten;
        }
      })
      .catch(() => {});

    win.onMoved((event) => {
      if (moveTimerRef.current) {
        clearTimeout(moveTimerRef.current);
      }
      moveTimerRef.current = setTimeout(() => {
        void win.scaleFactor()
          .then((scale) => layoutSwitcherService.saveState({
            windowX: event.payload.x / scale,
            windowY: event.payload.y / scale,
            pinned: true,
          }))
          .catch(() => {});
      }, 300);
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        unlistenMoved = unlisten;
      }
    }).catch(() => {});

    void emitTo("main", REQUEST_STATE_EVENT).catch(() => {});

    return () => {
      disposed = true;
      unlistenState?.();
      unlistenMoved?.();
    };
  }, []);

  async function closeWindow() {
    const state = await layoutSwitcherService.getState().catch(() => ({
      windowX: null,
      windowY: null,
      pinned: false,
    }));
    await layoutSwitcherService.saveState({ ...state, pinned: false }).catch(() => {});
    try {
      await getCurrentWindow().close();
    } catch {
      /* Best effort close. */
    }
  }

  return (
    <div
      className="flex h-screen w-screen flex-col overflow-hidden text-sm"
      style={{ background: "var(--app-panel-bg)", color: "var(--app-text-primary)" }}
    >
      <div
        data-tauri-drag-region
        className="flex h-10 shrink-0 select-none items-center justify-between border-b px-3"
        style={{ borderColor: "var(--app-border)" }}
      >
        <div data-tauri-drag-region className="min-w-0 truncate text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--app-text-tertiary)" }}>
          {t("layoutSwitcherTitle")}
        </div>
        <button
          type="button"
          aria-label={t("closeLayoutSwitcher")}
          title={t("closeLayoutSwitcher")}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--app-hover)]"
          onClick={() => void closeWindow()}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {snapshot.layouts.map((layout) => {
          const selected = layout.id === snapshot.currentLayoutId;
          return (
            <button
              key={layout.id}
              type="button"
              className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-[var(--app-hover)]"
              style={{
                background: selected ? "var(--app-active-bg)" : "transparent",
                color: selected ? "var(--app-text-primary)" : "var(--app-text-secondary)",
              }}
              onClick={() => void emitTo("main", SWITCH_EVENT, { layoutId: layout.id }).catch(() => {})}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                {selected ? (
                  <Check className="h-3.5 w-3.5" />
                ) : layout.kind === "starred" ? (
                  <Star className="h-3.5 w-3.5" fill="currentColor" style={{ color: "var(--app-accent)" }} />
                ) : null}
              </span>
              <span className="min-w-0 flex-1 truncate">{layout.name}</span>
              {layout.kind === "starred" ? null : (
                <PaneStatusDots paneSessionIds={layout.paneSessionIds} statusMap={statusMap} />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

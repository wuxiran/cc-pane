// ccchan 的「任务球」外观：桌面上的小圆球，悬停展开会话列表并切换会话。
//
// 复用桌宠的透明置顶窗口、位置记忆、点击穿透、会话状态聚合（usePetSessions）
// 与 focus-session 跳转。收起时窗口只有球那么大，展开时后端临时扩大窗口
// （set_ccchan_orb_expanded），球在屏幕上不动。
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type WheelEvent } from "react";
import { isTauriRuntime } from "@/services/runtime";
import { useCCChanStore } from "@/stores/useCCChanStore";
import { listenCCChan } from "./listen";
import { OrbPanel } from "./OrbPanel";
import {
  buildOrbEntries,
  COLLAPSED_ORB_LAYOUT,
  localExpandedLayout,
  orbCenter,
  orbClickTarget,
  orbPanelHeight,
  orbPanelRect,
  orbRingGradient,
  orbRingSegments,
  orderOrbEntries,
  ORB_PADDING,
  ORB_SIZE,
  type OrbLayout,
} from "./orbModel";
import type { HitRect } from "./petLayout";
import { orbContextMenu, popupMenu, type OrbMenuActions } from "./petMenus";
import { TaskOrb } from "./TaskOrb";
import { useOrbHover } from "./useOrbHover";
import { useOrbPinned } from "./useOrbPinned";
import { usePetPointerGesture } from "./usePetPointerGesture";
import { usePetSessions } from "./usePetSessions";
import { useHitRegions, usePetHover, usePetWindowChrome } from "./usePetWindow";
import type { CCChanAppearance } from "./types";

const AGE_REFRESH_MS = 5_000;

function isLayout(value: unknown): value is OrbLayout {
  return Boolean(value) && typeof (value as OrbLayout).width === "number";
}

/** 展开 / 收起：后端改窗口尺寸并返回布局；不可用时退回本地布局。 */
function useOrbLayout(open: boolean, panelHeight: number): OrbLayout {
  const [layout, setLayout] = useState<OrbLayout>(COLLAPSED_ORB_LAYOUT);
  const requested = useRef(false);
  useEffect(() => {
    // 首次挂载不发收起：此刻后端可能正在换外观重锚定窗口，别去抢。
    if (!open && !requested.current) return;
    requested.current = true;
    let cancelled = false;
    const fallback = open ? localExpandedLayout(panelHeight) : COLLAPSED_ORB_LAYOUT;
    const request = isTauriRuntime()
      ? invoke<OrbLayout>("set_ccchan_orb_expanded", { expanded: open, panelHeight })
      : Promise.resolve(fallback);
    request
      .then((next) => { if (!cancelled) setLayout(isLayout(next) ? next : fallback); })
      .catch((error: unknown) => {
        console.warn("[ccchan] orb layout:", error);
        if (!cancelled) setLayout(fallback);
      });
    return () => { cancelled = true; };
  }, [open, panelHeight]);
  return layout;
}

export function TaskOrbApp() {
  const { t } = useTranslation("ccchan");
  const settings = useCCChanStore((state) => state.settings);
  const saveSettings = useCCChanStore((state) => state.saveSettings);
  const { entries, directory } = usePetSessions();
  const [pinned, togglePin] = useOrbPinned();
  const orbEntries = useMemo(() => buildOrbEntries(entries, directory), [entries, directory]);
  const ordered = useMemo(
    () => orderOrbEntries(orbEntries, { sort: settings.orbSort, pinned }),
    [orbEntries, pinned, settings.orbSort],
  );
  const center = orbCenter(entries);
  const ring = useMemo(() => orbRingGradient(orbRingSegments(ordered)), [ordered]);

  const presence = usePetHover(0);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!presence.hovered) setDragging(false);
  }, [presence.hovered]);

  const focusSession = useCallback((sessionId: string) => {
    void emitTo("main", "ccchan:focus-session", { sessionId });
  }, []);

  const hover = useOrbHover({
    hovered: presence.hovered,
    dragging,
    hoverSwitch: settings.orbHoverSwitch,
    onDwell: focusSession,
  });
  const { open, highlight, openNow, close, setHighlight, rowEnter, rowLeave } = hover;

  const panelHeight = orbPanelHeight(ordered);
  const layout = useOrbLayout(open, panelHeight);
  const panelVisible = open && layout.expanded;
  const panelRect = orbPanelRect(layout);
  const orbX = layout.orbX + ORB_PADDING;
  const orbY = layout.orbY + ORB_PADDING;

  const regions: HitRect[] = [{ x: orbX, y: orbY, width: ORB_SIZE, height: ORB_SIZE }];
  if (panelVisible) regions.push(panelRect);
  usePetWindowChrome(true);
  useHitRegions(regions, panelVisible);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), AGE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [open]);

  // 列表行悬停：后端推的原生光标坐标（窗口失焦时 DOM hover 不可靠）。
  useEffect(() => listenCCChan<{ x: number; y: number }>("ccchan:cursor", ({ payload }) => {
    if (typeof document.elementFromPoint !== "function") return;
    const target = document.elementFromPoint(payload.x, payload.y);
    const row = target?.closest<HTMLElement>("[data-orb-row]");
    if (!row || target?.closest("[data-orb-pin]")) {
      rowLeave();
      return;
    }
    rowEnter(row.dataset.orbRow ?? "", Number(row.dataset.orbIndex ?? 0));
  }), [rowEnter, rowLeave]);

  const select = useCallback((sessionId: string) => {
    close();
    focusSession(sessionId);
  }, [close, focusSession]);

  const handleClick = useCallback(() => {
    const target = orbClickTarget(ordered, open, highlight);
    if (target) select(target.sessionId);
    else openNow();
  }, [highlight, open, openNow, ordered, select]);

  const pointer = usePetPointerGesture(handleClick, () => setDragging(true));

  const moveHighlight = useCallback((delta: number) => {
    rowLeave();
    const last = Math.max(0, ordered.all.length - 1);
    setHighlight(Math.min(last, Math.max(0, highlight + delta)));
  }, [highlight, ordered.all.length, rowLeave, setHighlight]);

  // 列表展开时的键盘：↑↓ 移动高亮、回车确认、1–9 跳转、Esc 收起（需要窗口有焦点）。
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        moveHighlight(event.key === "ArrowDown" ? 1 : -1);
      } else if (event.key === "Enter") {
        const target = ordered.all[highlight];
        if (target) select(target.sessionId);
      } else if (/^[1-9]$/.test(event.key)) {
        const target = ordered.all[Number(event.key) - 1];
        if (target) select(target.sessionId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, highlight, moveHighlight, open, ordered.all, select]);

  const onWheel = (event: WheelEvent<HTMLButtonElement>) => {
    if (!open) openNow();
    else moveHighlight(event.deltaY > 0 ? 1 : -1);
  };

  const actions: OrbMenuActions = useMemo(() => ({
    focusSession,
    openSettings: () => void emitTo("main", "ccchan:open-settings"),
    hide: () => {
      void invoke("hide_ccchan")
        .then(() => useCCChanStore.getState().setWindowVisible(false))
        .catch((error) => console.warn("[ccchan] hide:", error));
    },
    setAppearance: (appearance: CCChanAppearance) => void saveSettings({ ...settings, appearance }),
    resetPosition: () => void saveSettings({ ...settings, windowX: null, windowY: null, windowPosPhysical: true }),
  }), [focusSession, saveSettings, settings]);

  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    if (!(event.target as HTMLElement).closest("[data-testid='task-orb']")) return;
    close();
    void popupMenu(orbContextMenu(entries, t, actions));
  };

  const updateSettings = (patch: Partial<typeof settings>) => void saveSettings({ ...settings, ...patch });

  return (
    <div
      className="ccchan-window relative select-none"
      style={{ width: "100vw", height: "100vh", background: "transparent" }}
      onPointerLeave={presence.onPointerLeave}
      onContextMenu={onContextMenu}
    >
      {panelVisible && (
        <OrbPanel
          rect={panelRect}
          ordered={ordered}
          total={entries.length}
          need={center.count}
          sort={settings.orbSort}
          hoverSwitch={settings.orbHoverSwitch}
          highlight={highlight}
          dwellId={hover.dwellId}
          pinned={pinned}
          now={now}
          onRowEnter={rowEnter}
          onRowLeave={rowLeave}
          onSelect={select}
          onTogglePin={togglePin}
          onSort={(orbSort) => {
            setHighlight(0);
            updateSettings({ orbSort });
          }}
          onHoverSwitch={(orbHoverSwitch) => updateSettings({ orbHoverSwitch })}
          onPointerEnter={presence.onPointerEnter}
        />
      )}
      <TaskOrb
        x={orbX}
        y={orbY}
        ring={ring}
        center={center}
        pulse={center.waiting > 0 && !open}
        onPointerEnter={presence.onPointerEnter}
        onWheel={onWheel}
        onPointerDown={pointer.onPointerDown}
        onPointerMove={pointer.onPointerMove}
        onPointerUp={pointer.onPointerUp}
        onPointerCancel={pointer.onPointerCancel}
      />
    </div>
  );
}

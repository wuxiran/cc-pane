import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Toaster, toast } from "sonner";
import { useCCChanStore } from "@/stores/useCCChanStore";
import { useTerminalStatusStore } from "@/stores";
import type { TerminalStatusInfo, TerminalStatusType } from "@/types";
import { aggregateStatus } from "./statusAggregator";
import { ChatPanel } from "./ChatPanel";
import { ContextMenu, type CCChanContextMenuPosition } from "./ContextMenu";
import { SessionDots } from "./SessionDots";
import { SpritePet } from "./SpritePet";
import type { CCChanEvent, CCChanPetState } from "./types";

const PET_SIZE = 120;
const CHAT_EXPANDED_W = 460;
const CHAT_EXPANDED_H = 640;
const MENU_W = 460;
const MENU_H = 260;
const INITIAL_WANDER_AFTER_MS = 4_000;
const WANDER_REPEAT_MIN_MS = 8_000;
const WANDER_REPEAT_MAX_MS = 18_000;
const WANDER_SPEED_PX_PER_SEC = 110;
const WANDER_STEP_MS = 120;
const WANDER_EDGE_PAD = 40;
const WANDER_MIN_DISTANCE = 160;

function getEventPetState(event: CCChanEvent): CCChanPetState {
  if (event.kind === "task-complete") return "happy";
  if (event.kind === "task-failed") return "sad";
  return "waiting";
}

export function CCChanApp() {
  const settings = useCCChanStore((state) => state.settings);
  const pets = useCCChanStore((state) => state.pets);
  const expanded = useCCChanStore((state) => state.expanded);
  const chatSessionId = useCCChanStore((state) => state.chatSessionId);
  const loadCCChan = useCCChanStore((state) => state.load);
  const setExpanded = useCCChanStore((state) => state.setExpanded);
  const setChatSessionId = useCCChanStore((state) => state.setChatSessionId);
  const setWindowVisible = useCCChanStore((state) => state.setWindowVisible);
  const setPosition = useCCChanStore((state) => state.setPosition);
  const switchPet = useCCChanStore((state) => state.switchPet);
  const initTerminalStatus = useTerminalStatusStore((state) => state.init);
  const cleanupTerminalStatus = useTerminalStatusStore((state) => state.cleanup);
  const statusMap = useTerminalStatusStore((state) => state.statusMap);

  const [eventState, setEventState] = useState<CCChanPetState | null>(null);
  const [eggState, setEggState] = useState<CCChanPetState | null>(null);
  const [bubbleText, setBubbleText] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<CCChanContextMenuPosition | null>(null);
  const [menuOwnsResize, setMenuOwnsResize] = useState(false);
  const dragStartedAtRef = useRef<number | null>(null);
  const suppressNextClickRef = useRef(false);

  const selectedPet = useMemo(
    () => pets.find((pet) => pet.id === settings.defaultPetId) ?? pets[0],
    [pets, settings.defaultPetId],
  );

  const aggregateState = useMemo(() => {
    const statuses = Array.from(statusMap.values()).map((info) => info.status as TerminalStatusType);
    return aggregateStatus(statuses);
  }, [statusMap]);

  const petState = eventState ?? eggState ?? aggregateState;

  useEffect(() => {
    if (eventState || expanded || menuPosition) {
      setEggState(null);
      return;
    }

    let cancelled = false;
    let nextTimer: ReturnType<typeof setTimeout> | null = null;
    let stepTimer: ReturnType<typeof setTimeout> | null = null;

    function clearTimers() {
      if (nextTimer) clearTimeout(nextTimer);
      if (stepTimer) clearTimeout(stepTimer);
      nextTimer = null;
      stepTimer = null;
    }

    function scheduleNext() {
      if (cancelled) return;
      const next = WANDER_REPEAT_MIN_MS + Math.random() * (WANDER_REPEAT_MAX_MS - WANDER_REPEAT_MIN_MS);
      nextTimer = setTimeout(wander, next);
    }

    async function wander() {
      if (cancelled) {
        scheduleNext();
        return;
      }
      try {
        const win = getCurrentWindow();
        const monitor = await currentMonitor();
        const physicalPos = await win.outerPosition();
        const scale = await win.scaleFactor();
        const startX = physicalPos.x / scale;
        const startY = physicalPos.y / scale;
        if (!monitor) {
          scheduleNext();
          return;
        }
        const mScale = monitor.scaleFactor;
        const mx = monitor.position.x / mScale;
        const my = monitor.position.y / mScale;
        const mw = monitor.size.width / mScale;
        const mh = monitor.size.height / mScale;
        let targetX = startX;
        let targetY = startY;
        let dist = 0;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          targetX = mx + WANDER_EDGE_PAD + Math.random() * Math.max(1, mw - WANDER_EDGE_PAD * 2 - PET_SIZE);
          targetY = my + WANDER_EDGE_PAD + Math.random() * Math.max(1, mh - WANDER_EDGE_PAD * 2 - PET_SIZE);
          dist = Math.hypot(targetX - startX, targetY - startY);
          if (dist >= WANDER_MIN_DISTANCE) break;
        }
        const dx = targetX - startX;
        const dy = targetY - startY;
        if (dist < 30) {
          scheduleNext();
          return;
        }
        const duration = Math.min(12_000, Math.max(1_600, (dist / WANDER_SPEED_PX_PER_SEC) * 1000));
        const startTime = performance.now();
        setEggState("walking");

        const stepOnce = async () => {
          if (cancelled) return;
          const elapsed = performance.now() - startTime;
          const t = Math.min(1, elapsed / duration);
          const nx = startX + dx * t;
          const ny = startY + dy * t;
          const done = t >= 1;
          await invoke("move_ccchan_window", { x: nx, y: ny, persist: done }).catch(() => {});
          if (done || cancelled) {
            setEggState(null);
            scheduleNext();
            return;
          }
          stepTimer = setTimeout(stepOnce, WANDER_STEP_MS);
        };
        stepOnce();
      } catch {
        setEggState(null);
        scheduleNext();
      }
    }

    nextTimer = setTimeout(wander, INITIAL_WANDER_AFTER_MS);
    return () => {
      cancelled = true;
      clearTimers();
      setEggState(null);
    };
  }, [eventState, expanded, menuPosition]);

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = "html, body, #root { background: transparent !important; margin: 0; padding: 0; overflow: hidden; }";
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  useEffect(() => {
    void loadCCChan();
    void initTerminalStatus();
    invoke<TerminalStatusInfo[]>("get_all_terminal_status")
      .then((statuses) => {
        if (!Array.isArray(statuses)) return;
        useTerminalStatusStore.setState(() => {
          const next = new Map(statuses.map((status) => [status.sessionId, status]));
          return { statusMap: next };
        });
      })
      .catch(() => {});
    return cleanupTerminalStatus;
  }, [cleanupTerminalStatus, initTerminalStatus, loadCCChan]);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    listen<CCChanEvent>("ccchan-event", (event) => {
      const payload = event.payload;
      const nextState = getEventPetState(payload);
      const title = payload.title ?? payload.sessionId;
      setEventState(nextState);
      setBubbleText(payload.kind === "task-complete" ? `${title} 完成` : payload.kind === "task-failed" ? `${title} 失败` : `${title} 等待输入`);
      if (payload.kind === "task-complete") toast.success(title);
      if (payload.kind === "task-failed") toast.error(title);
      if (payload.kind === "task-waiting") toast.info(title);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        setEventState(null);
        setBubbleText(null);
      }, 3600);
    }).then((fn) => {
      unlisten = fn;
    }).catch(() => {});

    return () => {
      if (timer) clearTimeout(timer);
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    function handleMouseUp() {
      const startedAt = dragStartedAtRef.current;
      if (!startedAt) return;
      dragStartedAtRef.current = null;
      if (Date.now() - startedAt > 180) suppressNextClickRef.current = true;
      setTimeout(async () => {
        try {
          const win = getCurrentWindow();
          const physicalPos = await win.outerPosition();
          const scale = await win.scaleFactor();
          const logicalX = physicalPos.x / scale;
          const logicalY = physicalPos.y / scale;
          setPosition(logicalX, logicalY);
          await invoke("move_ccchan_window", { x: logicalX, y: logicalY });
        } catch {
          /* drag end save best-effort */
        }
      }, 0);
    }

    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, [setPosition]);

  async function openChat() {
    if (expanded) return;
    await invoke("resize_ccchan_for_chat", { expanded: true });
    setExpanded(true);
  }

  async function closeChat() {
    await invoke("resize_ccchan_for_chat", { expanded: false });
    setExpanded(false);
  }

  function handleMouseDown(event: MouseEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    dragStartedAtRef.current = Date.now();
    getCurrentWindow().startDragging().catch(() => {});
  }

  async function handleContextMenu(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    const openedForMenu = !expanded;
    if (openedForMenu) {
      await invoke("resize_ccchan_for_menu", { expanded: true }).catch(() => {});
    }
    setMenuOwnsResize(openedForMenu);
    // Place menu just below mascot (mascot occupies top-left 120×120 of the
    // expanded 300×280 window). Keep within the expanded window bounds.
    setMenuPosition({ x: Math.min(event.clientX, 140), y: Math.min(event.clientY + 4, 130) });
  }

  function closeMenu() {
    setMenuPosition(null);
    if (menuOwnsResize) {
      setMenuOwnsResize(false);
      void invoke("resize_ccchan_for_menu", { expanded: false }).catch(() => {});
    }
  }

  async function hideWindow() {
    await invoke("hide_ccchan");
    setWindowVisible(false);
  }

  if (!selectedPet) return null;

  return (
    <div
      className="relative select-none"
      style={{
        width: expanded ? CHAT_EXPANDED_W : menuPosition ? MENU_W : PET_SIZE,
        height: expanded ? CHAT_EXPANDED_H : menuPosition ? MENU_H : PET_SIZE,
        background: "transparent",
      }}
      onClick={() => {
        if (suppressNextClickRef.current) {
          suppressNextClickRef.current = false;
        }
      }}
    >
      <div className="absolute left-0 top-0" style={{ width: PET_SIZE, height: PET_SIZE }}>
        <div className="pointer-events-auto absolute left-1/2 top-1 z-10 -translate-x-1/2">
          <SessionDots />
        </div>
        {bubbleText && (
          <div
            className="absolute left-[112px] top-1 max-w-[280px] rounded-md border px-2 py-1 text-[12px] shadow-lg"
            style={{
              background: "var(--app-content)",
              borderColor: "var(--app-border)",
              color: "var(--app-text-primary)",
            }}
          >
            {bubbleText}
          </div>
        )}
        <SpritePet
          pet={selectedPet}
          state={petState}
          size={PET_SIZE}
          title="打开 cc酱 chat"
          onMouseDown={handleMouseDown}
          onContextMenu={(event) => void handleContextMenu(event)}
          onClick={(event) => {
            event.stopPropagation();
            if (suppressNextClickRef.current) {
              suppressNextClickRef.current = false;
              return;
            }
            void openChat().catch(() => {});
          }}
        />
      </div>

      <div
        className="absolute left-3 transition-all duration-200"
        style={{
          top: PET_SIZE + 12,
          opacity: expanded ? 1 : 0,
          transform: expanded ? "translateY(0)" : "translateY(-6px)",
          pointerEvents: expanded ? "auto" : "none",
        }}
      >
        {expanded && (
          <ChatPanel
            settings={settings}
            sessionId={chatSessionId}
            onSessionIdChange={setChatSessionId}
            onClose={() => void closeChat().catch(() => {})}
          />
        )}
      </div>

      {menuPosition && (
        <ContextMenu
          position={menuPosition}
          onHide={() => void hideWindow().catch(() => {})}
          onSwitchPet={switchPet}
          onOpenSettings={() => void emitTo("main", "ccchan:open-settings")}
          onExit={() => {
            if (chatSessionId) void invoke("stop_ccchan_chat", { sessionId: chatSessionId }).catch(() => {});
            void getCurrentWindow().close().catch(() => {});
          }}
          onClose={closeMenu}
        />
      )}

      <Toaster position="top-center" richColors />
    </div>
  );
}

import { invoke } from "@tauri-apps/api/core";
import { emitTo, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { MessageCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { Toaster } from "sonner";
import { TOASTER_OFFSET_CCCHAN, TOASTER_POSITION, toastErr, toastInfo, toastOk } from "@/lib/feedback";
import { useCCChanStore } from "@/stores/useCCChanStore";
import { useTerminalStatusStore } from "@/stores";
import type { TerminalStatusInfo, TerminalStatusType } from "@/types";
import { getErrorMessage } from "@/utils";
import { devDebugLog } from "@/utils/devLogger";
import { aggregateStatus } from "./statusAggregator";
import { ChatPanel, type ChatMessage } from "./ChatPanel";
import { ContextMenu, type CCChanContextMenuPosition } from "./ContextMenu";
import { SessionDots } from "./SessionDots";
import { SpritePet } from "./SpritePet";
import { getCCChanLayout } from "./ccchanLayout";
import type { CCChanEvent, CCChanPetState, CCChanSettings } from "./types";

const BUBBLE_INITIAL_MS = 12_000;
const BUBBLE_REPEAT_MIN_MS = 42_000;
const BUBBLE_REPEAT_MAX_MS = 95_000;
const BUBBLE_DURATION_MS = 5_400;
const PET_CLICK_MAX_MS = 900;
const PET_CLICK_MOVE_THRESHOLD_PX = 5;
const PET_DRAG_THROTTLE_MS = 16;
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

type BubbleSource = "event" | "idle" | "manual";

interface BubbleMessage {
  id: number;
  source: BubbleSource;
  text: string;
}

interface CCChanSayEvent {
  text: string;
  durationMs?: number;
}

interface PetPointerGesture {
  pointerId: number;
  startedAt: number;
  startScreenX: number;
  startScreenY: number;
  startWindowX: number;
  startWindowY: number;
  windowPositionReady: boolean;
  dragging: boolean;
  lastMoveAt: number;
  moveFailLogged: boolean;
}

const IDLE_BUBBLE_KEYS = ["bubbles.idle.nearby", "bubbles.idle.stuck", "bubbles.idle.openChat", "bubbles.idle.background", "bubbles.idle.output"] as const;
const WORKING_BUBBLE_KEYS = ["bubbles.working.running", "bubbles.working.working", "bubbles.working.status"] as const;
const WAITING_BUBBLE_KEYS = ["bubbles.waiting.input", "bubbles.waiting.jump", "bubbles.waiting.reminder"] as const;
type BubbleKey = (typeof IDLE_BUBBLE_KEYS | typeof WORKING_BUBBLE_KEYS | typeof WAITING_BUBBLE_KEYS)[number];

function randomDelay(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function pickOne<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] ?? items[0]!;
}

function pickIdleBubbleKey(state: CCChanPetState, activeSessions: number): BubbleKey {
  if (state === "waiting") return pickOne(WAITING_BUBBLE_KEYS);
  if (state === "working" || activeSessions > 0) return pickOne(WORKING_BUBBLE_KEYS);
  return pickOne(IDLE_BUBBLE_KEYS);
}

function debugCCChan(event: string, payload: Record<string, unknown> = {}): void {
  devDebugLog("ccchan-debug", event, payload);
}

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input, textarea, [contenteditable='true'], [contenteditable='']"));
}

export function CCChanApp() {
  const { t } = useTranslation("ccchan");
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
  const applySettings = useCCChanStore((state) => state.applySettings);
  const initTerminalStatus = useTerminalStatusStore((state) => state.init);
  const cleanupTerminalStatus = useTerminalStatusStore((state) => state.cleanup);
  const statusMap = useTerminalStatusStore((state) => state.statusMap);

  const [eventState, setEventState] = useState<CCChanPetState | null>(null);
  const [eggState, setEggState] = useState<CCChanPetState | null>(null);
  const [bubble, setBubble] = useState<BubbleMessage | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [menuPosition, setMenuPosition] = useState<CCChanContextMenuPosition | null>(null);
  const [menuOwnsResize, setMenuOwnsResize] = useState(false);
  const bubbleRef = useRef<BubbleMessage | null>(null);
  const bubbleIdRef = useRef(0);
  const petStateRef = useRef<CCChanPetState>("idle");
  const activeSessionCountRef = useRef(0);
  const petPointerRef = useRef<PetPointerGesture | null>(null);
  const expandedRef = useRef(expanded);
  const suppressNextClickRef = useRef(false);
  const manualBubbleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedPet = useMemo(
    () => pets.find((pet) => pet.id === settings.defaultPetId) ?? pets[0],
    [pets, settings.defaultPetId],
  );

  const layout = useMemo(() => getCCChanLayout(settings.petSize), [settings.petSize]);
  const petSize = layout.petSize;

  const aggregateState = useMemo(() => {
    const statuses = Array.from(statusMap.values()).map((info) => info.status as TerminalStatusType);
    return aggregateStatus(statuses);
  }, [statusMap]);

  const petState = eventState ?? eggState ?? aggregateState;
  const bubbleVisible = Boolean(bubble) && !expanded && !menuPosition;
  const activeSessionCount = statusMap.size;

  useEffect(() => {
    bubbleRef.current = bubble;
  }, [bubble]);

  useEffect(() => {
    petStateRef.current = petState;
    activeSessionCountRef.current = activeSessionCount;
  }, [activeSessionCount, petState]);

  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  const showBubble = useCallback((text: string, source: BubbleSource) => {
    const id = bubbleIdRef.current + 1;
    bubbleIdRef.current = id;
    setBubble({ id, source, text });
    return id;
  }, []);

  const clearBubble = useCallback((id?: number) => {
    setBubble((current) => {
      if (!current) return null;
      if (id !== undefined && current.id !== id) return current;
      return null;
    });
  }, []);

  const showManualBubble = useCallback((payload: CCChanSayEvent | null | undefined) => {
    const text = payload?.text?.trim();
    if (!text) {
      debugCCChan("bubble.manual.skip.empty", {});
      return;
    }
    const durationMs = Math.min(
      30_000,
      Math.max(1_200, payload?.durationMs ?? BUBBLE_DURATION_MS),
    );
    debugCCChan("bubble.manual.show", {
      textLength: text.length,
      durationMs,
    });
    const bubbleId = showBubble(text, "manual");
    if (manualBubbleTimerRef.current) clearTimeout(manualBubbleTimerRef.current);
    manualBubbleTimerRef.current = setTimeout(() => {
      clearBubble(bubbleId);
      manualBubbleTimerRef.current = null;
    }, durationMs);
  }, [clearBubble, showBubble]);

  const openChat = useCallback(async () => {
    if (expandedRef.current) {
      debugCCChan("chat.open.skip.already-expanded", {});
      return;
    }
    debugCCChan("chat.open.begin", {
      hadMenu: Boolean(menuPosition),
      hadBubble: Boolean(bubbleRef.current),
    });
    expandedRef.current = true;
    clearBubble();
    setMenuPosition(null);
    setMenuOwnsResize(false);
    try {
      await invoke("resize_ccchan_for_chat", { expanded: true });
      setExpanded(true);
      debugCCChan("chat.open.end", {});
    } catch (error) {
      expandedRef.current = false;
      debugCCChan("chat.open.fail", {
        error: getErrorMessage(error),
        rawError: error,
      });
      throw error;
    }
  }, [clearBubble, menuPosition, setExpanded]);

  useEffect(() => {
    if (expanded || menuPosition) return;
    // 拖拽手势进行中不重设窗口尺寸，避免窗口在手上突然跳动；
    // 新 petSize 会在下一次状态切换（气泡/菜单/chat）时生效。
    if (petPointerRef.current) return;
    void invoke("resize_ccchan_for_bubble", { expanded: bubbleVisible }).catch(() => {});
  }, [bubbleVisible, expanded, menuPosition, petSize]);

  useEffect(() => {
    if (!settings.wanderEnabled || eventState || expanded || menuPosition) {
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
          targetX = mx + WANDER_EDGE_PAD + Math.random() * Math.max(1, mw - WANDER_EDGE_PAD * 2 - petSize);
          targetY = my + WANDER_EDGE_PAD + Math.random() * Math.max(1, mh - WANDER_EDGE_PAD * 2 - petSize);
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
      // cancelled 同时挡住在途的 stepOnce（开关中途关闭时立即停止移动）。
      cancelled = true;
      clearTimers();
      setEggState(null);
    };
  }, [eventState, expanded, menuPosition, petSize, settings.wanderEnabled]);

  useEffect(() => {
    if (expanded || menuPosition || eventState) return;

    let cancelled = false;
    let showTimer: ReturnType<typeof setTimeout> | null = null;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;

    function clearTimers() {
      if (showTimer) clearTimeout(showTimer);
      if (hideTimer) clearTimeout(hideTimer);
      showTimer = null;
      hideTimer = null;
    }

    function scheduleNext(delayMs = randomDelay(BUBBLE_REPEAT_MIN_MS, BUBBLE_REPEAT_MAX_MS)) {
      if (cancelled) return;
      showTimer = setTimeout(() => {
        if (cancelled || expanded || menuPosition || eventState || bubbleRef.current) {
          scheduleNext();
          return;
        }

        const id = showBubble(
          t(pickIdleBubbleKey(petStateRef.current, activeSessionCountRef.current)),
          "idle",
        );
        hideTimer = setTimeout(() => {
          clearBubble(id);
          scheduleNext();
        }, BUBBLE_DURATION_MS);
      }, delayMs);
    }

    scheduleNext(BUBBLE_INITIAL_MS);
    return () => {
      cancelled = true;
      clearTimers();
    };
  }, [
    clearBubble,
    eventState,
    expanded,
    menuPosition,
    showBubble,
    t,
  ]);

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = "html, body, #root { background: transparent !important; margin: 0; padding: 0; overflow: hidden; }";
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  useEffect(() => {
    void loadCCChan();
    void initTerminalStatus().catch(() => {});
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
    if (!IS_MAC) return;

    const preventNativeCallout = (event: Event) => {
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
    };

    window.addEventListener("contextmenu", preventNativeCallout, true);
    window.addEventListener("selectstart", preventNativeCallout, true);
    return () => {
      window.removeEventListener("contextmenu", preventNativeCallout, true);
      window.removeEventListener("selectstart", preventNativeCallout, true);
    };
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    let webview: ReturnType<typeof getCurrentWebview>;
    try {
      webview = getCurrentWebview();
    } catch (error) {
      console.warn("[ccchan] failed to get webview for ccchan-event:", error);
      return;
    }

    webview.listen<CCChanEvent>("ccchan-event", (event) => {
      const payload = event.payload;
      const nextState = getEventPetState(payload);
      const title = payload.title ?? payload.sessionId;
      setEventState(nextState);
      const bubbleId = showBubble(
        payload.kind === "task-complete"
          ? t("events.completed", { title })
          : payload.kind === "task-failed"
            ? t("events.failed", { title })
            : t("events.waiting", { title }),
        "event",
      );
      if (payload.kind === "task-complete") toastOk(title);
      if (payload.kind === "task-failed") toastErr(title);
      if (payload.kind === "task-waiting") toastInfo(title);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        setEventState(null);
        clearBubble(bubbleId);
      }, 3600);
    }).then((fn) => {
      unlisten = fn;
    }).catch((error) => {
      console.warn("[ccchan] failed to listen ccchan-event:", error);
    });

    return () => {
      if (timer) clearTimeout(timer);
      unlisten?.();
    };
    // t 不进 deps：切语言会换 t 的 identity，重跑该 effect 会打断在途的会话 bootstrap
    // （cleanup 置 cancelled=true → setStarting(false) 被跳过 → 控件永久禁用 + CLI 进程成孤儿）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearBubble, showBubble]);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    const handleDomSay = (event: Event) => {
      showManualBubble((event as CustomEvent<CCChanSayEvent>).detail);
    };

    window.addEventListener("ccchan-say-dom", handleDomSay);
    try {
      getCurrentWebview().listen<CCChanSayEvent>("ccchan-say", (event) => {
        showManualBubble(event.payload);
      }).then((fn) => {
        unlisten = fn;
      }).catch((error) => {
        console.warn("[ccchan] failed to listen ccchan-say:", error);
      });
    } catch (error) {
      console.warn("[ccchan] failed to register ccchan-say listener:", error);
    }

    return () => {
      window.removeEventListener("ccchan-say-dom", handleDomSay);
      if (manualBubbleTimerRef.current) {
        clearTimeout(manualBubbleTimerRef.current);
        manualBubbleTimerRef.current = null;
      }
      unlisten?.();
    };
  }, [showManualBubble]);

  // 主窗口保存 ccchan settings 后经 emitTo("ccchan", ...) 推送到这里，
  // 无需重启宠物窗口即可生效（漫游开关、尺寸、默认角色等）。
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    try {
      getCurrentWebview()
        .listen<CCChanSettings>("ccchan:settings-updated", (event) => {
          debugCCChan("settings.updated.received", { petSize: event.payload?.petSize });
          applySettings(event.payload);
        })
        .then((fn) => {
          unlisten = fn;
        })
        .catch((error) => {
          console.warn("[ccchan] failed to listen ccchan:settings-updated:", error);
        });
    } catch (error) {
      console.warn("[ccchan] failed to register settings-updated listener:", error);
    }
    return () => {
      unlisten?.();
    };
  }, [applySettings]);

  async function closeChat() {
    debugCCChan("chat.close.begin", {});
    expandedRef.current = false;
    try {
      await invoke("resize_ccchan_for_chat", { expanded: false });
      setExpanded(false);
      debugCCChan("chat.close.end", {});
    } catch (error) {
      expandedRef.current = true;
      debugCCChan("chat.close.fail", {
        error: getErrorMessage(error),
        rawError: error,
      });
      throw error;
    }
  }

  function resetPetPointer(reason = "reset") {
    const gesture = petPointerRef.current;
    if (gesture) {
      debugCCChan("pet.pointer.reset", {
        reason,
        pointerId: gesture.pointerId,
        dragging: gesture.dragging,
      });
    }
    petPointerRef.current = null;
  }

  function updatePetPointerWindowPosition(pointerId: number) {
    let win: ReturnType<typeof getCurrentWindow>;
    try {
      win = getCurrentWindow();
    } catch (error) {
      const gesture = petPointerRef.current;
      if (gesture && gesture.pointerId === pointerId) {
        gesture.windowPositionReady = true;
      }
      debugCCChan("pet.pointer.position.window.fail", {
        pointerId,
        error: getErrorMessage(error),
        rawError: error,
      });
      return;
    }
    void win.outerPosition()
      .then((position) => {
        const gesture = petPointerRef.current;
        if (!gesture || gesture.pointerId !== pointerId) return;
        gesture.startWindowX = position.x;
        gesture.startWindowY = position.y;
        gesture.windowPositionReady = true;
        debugCCChan("pet.pointer.position.ready", {
          pointerId,
          startWindowX: position.x,
          startWindowY: position.y,
        });
      })
      .catch((error) => {
        const gesture = petPointerRef.current;
        if (!gesture || gesture.pointerId !== pointerId) return;
        gesture.windowPositionReady = true;
        debugCCChan("pet.pointer.position.fallback", {
          pointerId,
          error: getErrorMessage(error),
          rawError: error,
        });
      });
  }

  async function ensurePetPointerWindowPosition(gesture: PetPointerGesture) {
    if (gesture.windowPositionReady) return;
    try {
      const position = await getCurrentWindow().outerPosition();
      gesture.startWindowX = position.x;
      gesture.startWindowY = position.y;
      debugCCChan("pet.pointer.position.ready.lazy", {
        pointerId: gesture.pointerId,
        startWindowX: position.x,
        startWindowY: position.y,
      });
    } catch (error) {
      debugCCChan("pet.pointer.position.lazy.fallback", {
        pointerId: gesture.pointerId,
        error: getErrorMessage(error),
        rawError: error,
      });
    } finally {
      gesture.windowPositionReady = true;
    }
  }

  function handlePetPointerDown(event: PointerEvent<HTMLButtonElement>) {
    debugCCChan("pet.pointer.down", {
      button: event.button,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      screenX: event.screenX,
      screenY: event.screenY,
    });
    if (event.button === 2) {
      event.preventDefault();
      event.stopPropagation();
      resetPetPointer("right-button");
      debugCCChan("pet.pointer.down.open-menu", {
        pointerId: event.pointerId,
      });
      openMenu();
      return;
    }
    if (event.button !== 0) {
      debugCCChan("pet.pointer.down.skip.non-left", {
        button: event.button,
        pointerId: event.pointerId,
      });
      return;
    }
    petPointerRef.current = {
      pointerId: event.pointerId,
      startedAt: Date.now(),
      startScreenX: event.screenX,
      startScreenY: event.screenY,
      startWindowX: 0,
      startWindowY: 0,
      windowPositionReady: false,
      dragging: false,
      lastMoveAt: 0,
      moveFailLogged: false,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch (error) {
      debugCCChan("pet.pointer.capture.fail", {
        pointerId: event.pointerId,
        error: getErrorMessage(error),
        rawError: error,
      });
    }
    updatePetPointerWindowPosition(event.pointerId);
    debugCCChan("pet.pointer.ready", {
      pointerId: event.pointerId,
    });
  }

  async function handlePetPointerMove(event: PointerEvent<HTMLButtonElement>) {
    const gesture = petPointerRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const dx = event.screenX - gesture.startScreenX;
    const dy = event.screenY - gesture.startScreenY;
    const movedPx = Math.hypot(dx, dy);
    if (movedPx < PET_CLICK_MOVE_THRESHOLD_PX && !gesture.dragging) return;
    const now = Date.now();
    if (now - gesture.lastMoveAt < PET_DRAG_THROTTLE_MS) return;
    const wasDragging = gesture.dragging;
    gesture.dragging = true;
    gesture.lastMoveAt = now;
    if (!wasDragging) {
      debugCCChan("pet.drag.start", {
        pointerId: event.pointerId,
        movedPx: Math.round(movedPx),
        thresholdPx: PET_CLICK_MOVE_THRESHOLD_PX,
      });
    }
    try {
      await ensurePetPointerWindowPosition(gesture);
      const scale = await getCurrentWindow().scaleFactor();
      await invoke("move_ccchan_window", {
        x: (gesture.startWindowX + dx) / scale,
        y: (gesture.startWindowY + dy) / scale,
        persist: false,
      });
    } catch (error) {
      if (!gesture.moveFailLogged) {
        gesture.moveFailLogged = true;
        debugCCChan("pet.drag.move.fail", {
          pointerId: event.pointerId,
          error: getErrorMessage(error),
          rawError: error,
        });
      }
    }
  }

  async function handlePetPointerUp(event: PointerEvent<HTMLButtonElement>) {
    const gesture = petPointerRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      debugCCChan("pet.pointer.up.skip.no-match", {
        pointerId: event.pointerId,
        activePointerId: gesture?.pointerId ?? null,
      });
      return;
    }
    resetPetPointer("pointer-up");
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* pointer capture release is best-effort */
    }
    const elapsed = Date.now() - gesture.startedAt;
    const dx = event.screenX - gesture.startScreenX;
    const dy = event.screenY - gesture.startScreenY;
    const movedPx = Math.hypot(dx, dy);
    if (!gesture.dragging && elapsed <= PET_CLICK_MAX_MS && movedPx <= PET_CLICK_MOVE_THRESHOLD_PX) {
      debugCCChan("pet.click.open-chat", {
        pointerId: event.pointerId,
        elapsedMs: elapsed,
        movedPx: Math.round(movedPx),
      });
      void openChat().catch(() => {});
      return;
    }
    suppressNextClickRef.current = true;
    debugCCChan("pet.drag.end", {
      pointerId: event.pointerId,
      elapsedMs: elapsed,
      movedPx: Math.round(movedPx),
      wasDragging: gesture.dragging,
    });
    try {
      const win = getCurrentWindow();
      const physicalPos = await win.outerPosition();
      const scale = await win.scaleFactor();
      const logicalX = physicalPos.x / scale;
      const logicalY = physicalPos.y / scale;
      setPosition(logicalX, logicalY);
      await invoke("move_ccchan_window", { x: logicalX, y: logicalY });
      debugCCChan("pet.drag.save-position.end", {
        x: Math.round(logicalX),
        y: Math.round(logicalY),
      });
    } catch (error) {
      debugCCChan("pet.drag.save-position.fail", {
        error: getErrorMessage(error),
        rawError: error,
      });
    }
  }

  function openMenu() {
    debugCCChan("menu.open.begin", {
      expanded,
      hadBubble: Boolean(bubbleRef.current),
    });
    clearBubble();
    const openedForMenu = !expanded;
    // Keep the menu away from the transparent ccchan window edge. Drawing it
    // beside the mascot avoids the hard WebView clipping line.
    const preferredX = petSize + 8;
    const preferredY = 16;
    const x = Math.max(
      layout.menuPad,
      Math.min(preferredX, layout.menuW - layout.menuPanelW - layout.menuPad),
    );
    const y = Math.max(
      layout.menuPad,
      Math.min(preferredY, layout.menuH - layout.menuPanelH - layout.menuPad),
    );
    debugCCChan("menu.open.position", {
      openedForMenu,
      immediateX: openedForMenu ? layout.menuPad : x,
      immediateY: openedForMenu ? layout.menuPad : y,
      finalX: x,
      finalY: y,
    });
    setMenuOwnsResize(openedForMenu);
    setMenuPosition(openedForMenu ? { x: layout.menuPad, y: layout.menuPad } : { x, y });
    if (openedForMenu) {
      void invoke("resize_ccchan_for_menu", { expanded: true })
        .then(() => {
          debugCCChan("menu.resize.end", {});
        })
        .catch((error) => {
          debugCCChan("menu.resize.fail", {
            error: getErrorMessage(error),
            rawError: error,
          });
        })
        .finally(() => {
          setMenuPosition({ x, y });
        });
    }
  }

  function handleContextMenu(event: MouseEvent<HTMLElement>) {
    debugCCChan("pet.contextmenu", {
      button: event.button,
      clientX: event.clientX,
      clientY: event.clientY,
    });
    event.preventDefault();
    event.stopPropagation();
    openMenu();
  }

  function closeMenu() {
    debugCCChan("menu.close", {
      menuOwnsResize,
    });
    setMenuPosition(null);
    if (menuOwnsResize) {
      setMenuOwnsResize(false);
      void invoke("resize_ccchan_for_menu", { expanded: false }).catch((error) => {
        debugCCChan("menu.close.resize.fail", {
          error: getErrorMessage(error),
          rawError: error,
        });
      });
    }
  }

  async function hideWindow() {
    debugCCChan("window.hide.begin", {});
    await invoke("hide_ccchan");
    setWindowVisible(false);
    debugCCChan("window.hide.end", {});
  }

  if (!selectedPet) return null;

  return (
    <div
      className="ccchan-window relative select-none"
      style={{
        width: expanded ? layout.chatW : menuPosition ? layout.menuW : bubbleVisible ? layout.bubbleW : petSize,
        height: expanded ? layout.chatH : menuPosition ? layout.menuH : bubbleVisible ? layout.bubbleH : petSize,
        background: "transparent",
      }}
      onClick={() => {
        if (suppressNextClickRef.current) {
          suppressNextClickRef.current = false;
          debugCCChan("root.click.suppressed-after-drag", {});
        }
      }}
      onContextMenu={handleContextMenu}
    >
      {bubbleVisible && bubble && (
        <div
          className="pointer-events-none absolute left-3 top-2 z-20 rounded-lg border-2 px-3 py-2 text-[13px] font-semibold leading-[19px] shadow-xl"
          style={{
            width: layout.bubbleTextW,
            background: "#ffffff",
            borderColor: "#38bdf8",
            color: "#0f172a",
            boxShadow: "0 14px 32px rgba(15, 23, 42, 0.28), 0 0 0 3px rgba(255, 255, 255, 0.72)",
          }}
        >
          <div
            className="absolute -bottom-2 left-[54px] h-3.5 w-3.5 rotate-45 border-b-2 border-r-2"
            style={{
              background: "#ffffff",
              borderColor: "#38bdf8",
            }}
          />
          <span className="relative z-10">{bubble.text}</span>
        </div>
      )}

      <div
        className="absolute"
        style={{
          width: petSize,
          height: petSize,
          left: bubbleVisible ? layout.bubblePetLeft : 0,
          top: bubbleVisible ? layout.bubblePetTop : 0,
        }}
      >
        <div className="pointer-events-auto absolute left-1/2 top-1 z-10 -translate-x-1/2">
          <SessionDots />
        </div>
        <button
          type="button"
          className="absolute right-1 top-8 z-20 flex h-8 w-8 items-center justify-center rounded-full border shadow-lg transition-transform hover:scale-105 active:scale-95"
          style={{
            background: "#ffffff",
            borderColor: "#bfdbfe",
            color: "#2563eb",
          }}
          title={t("openConversation")}
          onClick={(event) => {
            event.stopPropagation();
            debugCCChan("chat-button.click", {});
            void openChat().catch(() => {});
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            debugCCChan("chat-button.contextmenu", {});
            openMenu();
          }}
        >
          <MessageCircle size={16} />
        </button>
        <SpritePet
          pet={selectedPet}
          state={petState}
          size={petSize}
          title={t("openChat")}
          onContextMenu={handleContextMenu}
          onClick={(event) => {
            event.stopPropagation();
            if (suppressNextClickRef.current) {
              suppressNextClickRef.current = false;
              debugCCChan("pet.click.suppressed-after-drag", {});
              return;
            }
            debugCCChan("pet.click.native", {
              expanded: expandedRef.current,
            });
            void openChat().catch(() => {});
          }}
          onPointerCancel={(event) => {
            try {
              event.currentTarget.releasePointerCapture(event.pointerId);
            } catch {
              /* pointer capture release is best-effort */
            }
            resetPetPointer("pointer-cancel");
          }}
          onPointerDown={handlePetPointerDown}
          onPointerMove={(event) => void handlePetPointerMove(event)}
          onPointerUp={(event) => void handlePetPointerUp(event)}
        />
      </div>

      <div
        className="absolute transition-all duration-200"
        style={{
          left: layout.chatPanelLeft,
          top: layout.chatPanelTop,
          opacity: expanded ? 1 : 0,
          transform: expanded ? "translateY(0)" : "translateY(-6px)",
          pointerEvents: expanded ? "auto" : "none",
        }}
      >
        {expanded && (
          <ChatPanel
            settings={settings}
            sessionId={chatSessionId}
            messages={chatMessages}
            onMessagesChange={setChatMessages}
            onSessionIdChange={setChatSessionId}
            onClose={() => void closeChat().catch(() => {})}
            width={layout.chatPanelW}
            height={layout.chatPanelH}
          />
        )}
      </div>

      {menuPosition && (
        <ContextMenu
          position={menuPosition}
          onHide={() => void hideWindow().catch(() => {})}
          onOpenChat={() => void openChat().catch(() => {})}
          onSwitchPet={switchPet}
          onOpenSettings={() => void emitTo("main", "ccchan:open-settings")}
          onExit={() => {
            if (chatSessionId) void invoke("stop_ccchan_chat", { sessionId: chatSessionId }).catch(() => {});
            try {
              void getCurrentWindow().close().catch(() => {});
            } catch {
              /* getCurrentWindow may throw synchronously when internals unavailable */
            }
          }}
          onClose={closeMenu}
        />
      )}

      <Toaster position={TOASTER_POSITION} offset={TOASTER_OFFSET_CCCHAN} richColors />
    </div>
  );
}

import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";

import { MessageCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
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
import { usePetPointerGesture } from "./usePetPointerGesture";
import { useCCChanWindowMode } from "./useCCChanWindowMode";
import { usePetWander } from "./usePetWander";
import { listenCCChan } from "./listen";
import type { CCChanEvent, CCChanPetState, CCChanSettings, PetMeta } from "./types";

const BUBBLE_INITIAL_MS = 12_000;
const BUBBLE_REPEAT_MIN_MS = 42_000;
const BUBBLE_REPEAT_MAX_MS = 95_000;
const BUBBLE_DURATION_MS = 5_400;

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
  const translate = useRef(t);
  translate.current = t;
  const settings = useCCChanStore((state) => state.settings);
  const pets = useCCChanStore((state) => state.pets);
  const expanded = useCCChanStore((state) => state.expanded);
  const chatSessionId = useCCChanStore((state) => state.chatSessionId);
  const loadCCChan = useCCChanStore((state) => state.load);
  const setExpanded = useCCChanStore((state) => state.setExpanded);
  const setChatSessionId = useCCChanStore((state) => state.setChatSessionId);
  const setWindowVisible = useCCChanStore((state) => state.setWindowVisible);
  const switchPet = useCCChanStore((state) => state.switchPet);
  const applySettings = useCCChanStore((state) => state.applySettings);
  const initTerminalStatus = useTerminalStatusStore((state) => state.init);
  const cleanupTerminalStatus = useTerminalStatusStore((state) => state.cleanup);
  const statusMap = useTerminalStatusStore((state) => state.statusMap);

  const [eventState, setEventState] = useState<CCChanPetState | null>(null);
  const [eggState, setEggState] = useState<CCChanPetState | null>(null);
  const [bubble, setBubble] = useState<BubbleMessage | null>(null);
  const [chatMounted, setChatMounted] = useState(expanded);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [menuPosition, setMenuPosition] = useState<CCChanContextMenuPosition | null>(null);
  const bubbleRef = useRef<BubbleMessage | null>(null);
  const bubbleIdRef = useRef(0);
  const petStateRef = useRef<CCChanPetState>("idle");
  const activeSessionCountRef = useRef(0);
  const expandedRef = useRef(expanded);
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
    setChatMounted(true);
    setExpanded(true);
  }, [clearBubble, menuPosition, setExpanded]);

  const pointer = usePetPointerGesture(() => void openChat().catch((error) => toastErr(getErrorMessage(error))), openMenu);

  const mode = expanded ? "chat" : menuPosition ? "menu" : bubbleVisible ? "bubble" : "collapsed";
  const viewport = useCCChanWindowMode(mode, petSize, pointer.interacting);

  usePetWander(settings.wanderEnabled, Boolean(eventState || expanded || menuPosition || bubbleVisible || pointer.interacting), petSize, setEggState);

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
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unlisten = listenCCChan<CCChanEvent>("ccchan-event", (event) => {
      const payload = event.payload;
      const nextState = getEventPetState(payload);
      const title = payload.title ?? payload.sessionId;
      setEventState(nextState);
      const bubbleId = showBubble(
        payload.kind === "task-complete"
          ? translate.current("events.completed", { title })
          : payload.kind === "task-failed"
            ? translate.current("events.failed", { title })
            : translate.current("events.waiting", { title }),
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
    });
    return () => { if (timer) clearTimeout(timer); unlisten(); };
    // t 不进 deps：切语言会换 t 的 identity，重跑该 effect 会打断在途的会话 bootstrap
    // （cleanup 置 cancelled=true → setStarting(false) 被跳过 → 控件永久禁用 + CLI 进程成孤儿）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearBubble, showBubble]);

  useEffect(() => {
    const handleDomSay = (event: Event) => showManualBubble((event as CustomEvent<CCChanSayEvent>).detail);
    window.addEventListener("ccchan-say-dom", handleDomSay);
    let disposed = false;
    const receive = () => {
      void invoke<CCChanSayEvent | null>("take_ccchan_say").then((payload) => {
        if (!disposed) showManualBubble(payload);
      }).catch((error) => console.warn("[ccchan] receive message:", error));
    };
    const unlisten = listenCCChan("ccchan-say", receive, receive);
    return () => {
      disposed = true;
      window.removeEventListener("ccchan-say-dom", handleDomSay);
      if (manualBubbleTimerRef.current) clearTimeout(manualBubbleTimerRef.current);
      unlisten();
    };
  }, [showManualBubble]);

  // 主窗口保存 ccchan settings 后经 emitTo("ccchan", ...) 推送到这里，
  // 无需重启宠物窗口即可生效（漫游开关、尺寸、默认角色等）。
  useEffect(() => listenCCChan<CCChanSettings>("ccchan:settings-updated", ({ payload }) => applySettings(payload)), [applySettings]);

  useEffect(() => listenCCChan<PetMeta[]>("ccchan:pets-updated", ({ payload }) => useCCChanStore.getState().applyPets(payload)), []);

  async function closeChat() {
    expandedRef.current = false;
    setExpanded(false);
  }

  function openMenu() {
    if (menuPosition) return;
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
    setMenuPosition({ x, y });
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

  function closeMenu() { setMenuPosition(null); }

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
        width: "100vw",
        height: "100vh",
        background: "transparent",
      }}
      onContextMenu={handleContextMenu}
    >
      {bubbleVisible && bubble && (
        <div
          className="pointer-events-none absolute left-3 top-2 z-20 rounded-lg border-2 px-3 py-2 text-[13px] font-semibold leading-[19px] shadow-xl"
          style={{
            width: Math.min(layout.bubbleTextW, (viewport?.width ?? layout.bubbleW) - 24),
            maxHeight: layout.bubblePetTop - 16,
            overflow: "hidden",
            overflowWrap: "anywhere",
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
          onClick={(event) => { event.stopPropagation(); pointer.onClick(); }}
          onPointerDown={pointer.onPointerDown}
          onPointerMove={pointer.onPointerMove}
          onPointerUp={pointer.onPointerUp}
          onPointerCancel={pointer.onPointerCancel}
        />
      </div>

      <div
        inert={!expanded}
        aria-hidden={!expanded}
        className="absolute transition-all duration-200"
        style={{
          left: layout.chatPanelLeft,
          top: layout.chatPanelTop,
          opacity: expanded ? 1 : 0,
          transform: expanded ? "translateY(0)" : "translateY(-6px)",
          pointerEvents: expanded ? "auto" : "none",
        }}
      >
        {chatMounted && (
          <ChatPanel
            settings={settings}
            sessionId={chatSessionId}
            messages={chatMessages}
            onMessagesChange={setChatMessages}
            onSessionIdChange={setChatSessionId}
            onClose={() => void closeChat().catch(() => {})}
            width={Math.min(layout.chatPanelW, (viewport?.width ?? layout.chatW) - 28)}
            height={Math.min(layout.chatPanelH, (viewport?.height ?? layout.chatH) - layout.chatPanelTop - 24)}
          />
        )}
      </div>

      {menuPosition && (
        <ContextMenu
          position={menuPosition}
          onHide={() => void hideWindow().catch(() => {})}
          onOpenChat={() => void openChat().catch(() => {})}
          onSwitchPet={() => void switchPet().catch((error) => toastErr(getErrorMessage(error)))}
          onOpenSettings={() => void emitTo("main", "ccchan:open-settings")}
          onExit={() => void hideWindow().catch((error) => toastErr(getErrorMessage(error)))}
          onClose={closeMenu}
        />
      )}

      <Toaster position={TOASTER_POSITION} offset={TOASTER_OFFSET_CCCHAN} richColors />
    </div>
  );
}

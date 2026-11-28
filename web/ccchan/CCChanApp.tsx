// 桌宠窗口：Bot 形象 + 会话状态指示器。
//
// - 形象：当前 Bot 选的皮肤；没有 Bot 时是内置默认 cc酱。
// - 动画：全部终端会话 + 当前 Bot 对话聚合出的状态（petStatus.ts）。
// - 左键：跳到最紧急的会话；没有就在头顶弹出单行提问气泡（发给当前 Bot）。
// - 悬停：控件条（会话列表 / 提问 / 切换 Bot / 收起）；右键：原生菜单。
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { botService } from "@/services/botService";
import { useCCChanStore } from "@/stores/useCCChanStore";
import type { Bot, BotSummary } from "@/types/bot";
import { listenCCChan } from "./listen";
import { PetBubble } from "./PetBubble";
import { contextMenu, botMenu, popupMenu, sessionMenu, type PetMenuActions } from "./petMenus";
import { fitSprite, usePetBounds } from "./petBounds";
import { getPetLayout, hitRegions, type HitRect } from "./petLayout";
import { aggregatePetStatus, botPetStatus, pickClickTarget, PET_STATUS_PRIORITY } from "./petStatus";
import { PetToolbar } from "./PetToolbar";
import { SpritePet } from "./SpritePet";
import { useBotPet } from "./useBotPet";
import { usePetBubble } from "./usePetBubble";
import { usePetPointerGesture } from "./usePetPointerGesture";
import { usePetSessions } from "./usePetSessions";
import { useHitRegions, usePetHover, usePetWindowChrome } from "./usePetWindow";
import type { CCChanEvent, CCChanSettings, PetMeta } from "./types";

interface CCChanSayEvent {
  text: string;
  durationMs?: number;
}

const EVENT_BUBBLE_MS = 3_600;

/** 只换形象：把列表视图还原成 Bot 记录（运行态字段不回写）。 */
export function botWithPet(summary: BotSummary, petId: string): Bot {
  const { chatId: _chatId, effectiveCwd: _cwd, phase: _phase, ...bot } = summary;
  return { ...bot, petId };
}

export function CCChanApp() {
  const { t } = useTranslation("ccchan");
  const settings = useCCChanStore((state) => state.settings);
  const pets = useCCChanStore((state) => state.pets);
  const loadCCChan = useCCChanStore((state) => state.load);
  const saveSettings = useCCChanStore((state) => state.saveSettings);
  const applySettings = useCCChanStore((state) => state.applySettings);

  const { entries, directory } = usePetSessions();
  const { bots, activeBot, botState } = useBotPet(settings.activeBotId);
  const botName = activeBot?.name ?? t("brand");
  const { bubble, openInput, dismiss, notify, submit, cancel } = usePetBubble(
    activeBot?.id ?? null,
    t("bubble.cancelled"),
  );
  const hover = usePetHover();
  const [collapsed, setCollapsed] = useState(false);
  const [bubbleRect, setBubbleRect] = useState<HitRect | null>(null);

  const pet = useMemo<PetMeta | undefined>(() => {
    const byId = (id: string | null | undefined) => (id ? pets.find((item) => item.id === id) : undefined);
    return byId(activeBot?.petId) ?? byId(settings.defaultPetId) ?? pets[0];
  }, [activeBot?.petId, pets, settings.defaultPetId]);

  const layout = useMemo(() => getPetLayout(settings.petSize), [settings.petSize]);
  const bounds = usePetBounds(pet ?? pets[0]);
  const visible = fitSprite(bounds, layout.petSize).visible;

  const botStatus = botPetStatus(botState);
  const status = aggregatePetStatus([botStatus, ...entries.map((entry) => entry.status)]);
  const urgentCount = entries.filter((entry) => PET_STATUS_PRIORITY[entry.status] >= PET_STATUS_PRIORITY.ready).length;
  const toolbarVisible = hover.hovered && !collapsed;

  usePetWindowChrome(Boolean(pet));
  useHitRegions(hitRegions(layout, visible, { toolbar: toolbarVisible, bubble: bubble ? bubbleRect : null }));

  useEffect(() => {
    if (!hover.hovered) setCollapsed(false);
  }, [hover.hovered]);

  useEffect(() => {
    void loadCCChan();
  }, [loadCCChan]);

  useEffect(() => listenCCChan<CCChanSettings>("ccchan:settings-updated", ({ payload }) => applySettings(payload)), [applySettings]);
  useEffect(() => listenCCChan<PetMeta[]>("ccchan:pets-updated", ({ payload }) => useCCChanStore.getState().applyPets(payload)), []);

  // 会话事件：用标签名而不是会话 id 提示一句。目录走 ref，避免目录每次刷新都重订阅漏事件。
  const directoryRef = useRef(directory);
  directoryRef.current = directory;
  useEffect(() => listenCCChan<CCChanEvent>("ccchan-event", ({ payload }) => {
    const title = directoryRef.current.get(payload.sessionId)?.title || payload.sessionId.slice(0, 8);
    const key = payload.kind === "task-complete" ? "events.completed" : payload.kind === "task-failed" ? "events.failed" : "events.waiting";
    notify(t(key, { title }), EVENT_BUBBLE_MS);
  }), [notify, t]);

  // MCP ccchan_say：后端先存再 emit，窗口新建时 onReady 再补取一次。
  useEffect(() => {
    let disposed = false;
    const receive = () => {
      void invoke<CCChanSayEvent | null>("take_ccchan_say").then((payload) => {
        const text = payload?.text?.trim();
        if (disposed || !text) return;
        notify(text, Math.min(30_000, Math.max(1_200, payload?.durationMs ?? 5_400)));
      }).catch((error) => console.warn("[ccchan] receive message:", error));
    };
    const unlisten = listenCCChan("ccchan-say", receive, receive);
    return () => {
      disposed = true;
      unlisten();
    };
  }, [notify]);

  // 失焦（点了别处）收起回复 / 提示气泡；输入框自己处理失焦。
  useEffect(() => {
    const onBlur = () => {
      if (bubble && bubble.kind !== "input" && bubble.kind !== "pending") dismiss();
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [bubble, dismiss]);

  const openBotInMain = useCallback(() => {
    if (activeBot) void emitTo("main", "ccchan:open-bot-chat", { botId: activeBot.id });
  }, [activeBot]);

  const startAsk = useCallback(() => {
    if (!activeBot) {
      notify(t("bubble.noBot"), 4_000);
      void emitTo("main", "ccchan:open-bots", { create: true });
      return;
    }
    // 输入需要键盘焦点：宠物窗口平时不抢焦点。
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setFocus())
      .catch(() => {});
    openInput();
  }, [activeBot, notify, openInput, t]);

  const actions: PetMenuActions = useMemo(() => ({
    focusSession: (sessionId) => void emitTo("main", "ccchan:focus-session", { sessionId }),
    selectBot: (botId) => void saveSettings({ ...settings, activeBotId: botId }),
    createBot: () => void emitTo("main", "ccchan:open-bots", { create: true }),
    selectPet: (petId) => {
      if (activeBot) {
        void botService.save(botWithPet(activeBot, petId))
          .catch((error: unknown) => console.warn("[ccchan] save bot pet:", error));
      } else {
        void saveSettings({ ...settings, defaultPetId: petId });
      }
    },
    openSettings: () => void emitTo("main", "ccchan:open-settings"),
    hide: () => {
      void invoke("hide_ccchan")
        .then(() => useCCChanStore.getState().setWindowVisible(false))
        .catch((error) => console.warn("[ccchan] hide:", error));
    },
  }), [activeBot, saveSettings, settings]);

  const handleClick = useCallback(() => {
    const target = pickClickTarget(entries, botStatus);
    if (target.kind === "session") actions.focusSession(target.sessionId);
    else startAsk();
  }, [actions, botStatus, entries, startAsk]);

  const openContextMenu = useCallback(() => {
    void popupMenu(contextMenu({
      bots, activeBotId: activeBot?.id ?? null, pets, currentPetId: pet?.id ?? "", entries, t, actions,
    }));
  }, [actions, activeBot?.id, bots, entries, pet?.id, pets, t]);

  const pointer = usePetPointerGesture(handleClick);

  if (!pet) return null;

  const needsApproval = bubble?.kind === "pending" && botState.pendingRequests > 0;

  return (
    <div
      className="ccchan-window relative select-none"
      style={{ width: "100vw", height: "100vh", background: "transparent" }}
      onPointerLeave={hover.onPointerLeave}
      onContextMenu={(event: MouseEvent) => {
        event.preventDefault();
        if ((event.target as HTMLElement).closest("[data-pet-hit]")) openContextMenu();
      }}
    >
      {bubble && (
        <PetBubble
          bubble={bubble}
          botName={botName}
          needsApproval={needsApproval}
          windowWidth={layout.width}
          bottom={layout.bubbleBottom}
          onSubmit={submit}
          onDismiss={dismiss}
          onCancel={cancel}
          onOpenMain={() => {
            openBotInMain();
            if (bubble.kind !== "pending") dismiss();
          }}
          onRect={setBubbleRect}
        />
      )}

      {toolbarVisible && (
        <div data-pet-hit="" onPointerEnter={hover.onPointerEnter}>
          <PetToolbar
            top={layout.toolbarY}
            botName={botName}
            urgentCount={urgentCount}
            onSessions={() => void popupMenu(sessionMenu(entries, t, actions))}
            onAsk={startAsk}
            onSwitchBot={() => void popupMenu(botMenu(bots, activeBot?.id ?? null, t, actions))}
            onCollapse={() => {
              setCollapsed(true);
              dismiss();
            }}
          />
        </div>
      )}

      <div
        data-pet-hit=""
        className="absolute"
        style={{ left: layout.petX, top: layout.petY, width: layout.petSize, height: layout.petSize }}
        onPointerEnter={hover.onPointerEnter}
      >
        {urgentCount > 0 && !toolbarVisible && (
          <span
            data-testid="pet-urgent-badge"
            className="pointer-events-none absolute z-10 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[length:var(--text-micro)] font-semibold"
            style={{
              left: visible.x + visible.width - 8,
              top: Math.max(0, visible.y - 4),
              background: "var(--app-status-warning)",
              color: "var(--primary-foreground)",
            }}
          >
            {urgentCount > 9 ? "9+" : urgentCount}
          </span>
        )}
        <SpritePet
          pet={pet}
          status={status}
          size={layout.petSize}
          title={`${botName} · ${t(`status.${status}`)}`}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={pointer.onPointerDown}
          onPointerMove={pointer.onPointerMove}
          onPointerUp={pointer.onPointerUp}
          onPointerCancel={pointer.onPointerCancel}
        />
      </div>
    </div>
  );
}

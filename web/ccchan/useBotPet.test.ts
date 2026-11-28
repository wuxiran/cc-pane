import { describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import type { BotSummary } from "@/types/bot";
import { botMenu, contextMenu, sessionMenu, type PetMenuActions } from "./petMenus";
import { botPetStatus } from "./petStatus";
import { EMPTY_TRACKED, pickActiveBot, reduceBotEvent } from "./useBotPet";

const t = ((key: string) => key) as unknown as TFunction<"ccchan">;

function bot(id: string, name = id): BotSummary {
  return {
    id, name, avatar: "", color: "", persona: "", engineId: "claude", autoApproveKinds: [],
    createdAt: 0, updatedAt: 0, chatId: `bot-${id}`, effectiveCwd: "/tmp",
  };
}

function actions(): PetMenuActions {
  return {
    focusSession: vi.fn(), selectBot: vi.fn(), createBot: vi.fn(),
    selectPet: vi.fn(), openSettings: vi.fn(), hide: vi.fn(),
  };
}

describe("useBotPet reducer", () => {
  const event = (kind: string, payload: unknown) => ({ chatId: "bot-b1", kind, payload });

  it("tracks generating, approvals and errors of the bot conversation", () => {
    let state = reduceBotEvent(EMPTY_TRACKED, event("state", { phase: "generating" }));
    expect(botPetStatus(state)).toBe("running");
    state = reduceBotEvent(state, event("permission_request", { requestKey: "k1" }));
    state = reduceBotEvent(state, event("permission_request", { requestKey: "k1" }));
    expect(state.pendingRequests).toBe(1);
    expect(botPetStatus(state)).toBe("needsInput");
    state = reduceBotEvent(state, event("permission_resolved", { requestKey: "k1" }));
    expect(botPetStatus(state)).toBe("running");
    state = reduceBotEvent(state, event("turn_ended", { stopReason: "error", error: "boom" }));
    state = reduceBotEvent(state, event("state", { phase: "ready" }));
    expect(botPetStatus(state)).toBe("blocked");
    // 下一轮开始，旧错误作废。
    state = reduceBotEvent(state, event("state", { phase: "generating" }));
    expect(botPetStatus(state)).toBe("running");
    state = reduceBotEvent(state, event("turn_ended", { stopReason: "end_turn" }));
    state = reduceBotEvent(state, event("state", { phase: "ready" }));
    expect(botPetStatus(state)).toBe("idle");
  });

  it("falls back to the first bot when the stored one is gone", () => {
    const bots = [bot("a"), bot("b")];
    expect(pickActiveBot(bots, "b")?.id).toBe("b");
    expect(pickActiveBot(bots, "deleted")?.id).toBe("a");
    expect(pickActiveBot(bots, null)?.id).toBe("a");
    expect(pickActiveBot([], "a")).toBeNull();
  });
});

describe("petMenus", () => {
  it("lists sessions by name with a status mark and jumps on click", () => {
    const acts = actions();
    const items = sessionMenu([{ sessionId: "s1", title: "修复登录", status: "needsInput", updatedAt: 0 }], t, acts);
    expect(items[0]).toMatchObject({ kind: "item", text: "🟡 修复登录 · status.needsInput" });
    if (items[0].kind === "item") items[0].action?.();
    expect(acts.focusSession).toHaveBeenCalledWith("s1");
    expect(sessionMenu([], t, acts)[0]).toMatchObject({ enabled: false });
  });

  it("checks the active bot and always offers creating one", () => {
    const items = botMenu([bot("a", "A"), bot("b", "B")], "b", t, actions());
    expect(items.filter((item) => item.kind === "item" && item.checked).map((item) => item.kind === "item" && item.text))
      .toEqual(["🤖 B"]);
    expect(items[items.length - 1]).toMatchObject({ text: "menu.createBot" });
  });

  it("separates hide from the other context actions", () => {
    const acts = actions();
    const items = contextMenu({ bots: [], activeBotId: null, pets: [], currentPetId: "", entries: [], t, actions: acts });
    const hide = items.find((item) => item.kind === "item" && item.text === "menu.hide");
    const settings = items.find((item) => item.kind === "item" && item.text === "menu.settings");
    if (hide?.kind === "item") hide.action?.();
    expect(acts.hide).toHaveBeenCalledTimes(1);
    expect(acts.openSettings).not.toHaveBeenCalled();
    expect(settings).toBeDefined();
  });
});

// 宠物的右键菜单、会话列表、切换 Bot 都用系统原生菜单：不受宠物窗口大小限制，
// 也天然跟随系统深浅色。菜单结构由纯函数生成（便于测试），popup 时再实例化。
import type { TFunction } from "i18next";
import type { BotSummary } from "@/types/bot";
import type { PetStatus, SessionPetEntry } from "./petStatus";
import type { PetMeta } from "./types";

export type MenuSpec =
  | { kind: "item"; text: string; enabled?: boolean; checked?: boolean; action?: () => void }
  | { kind: "separator" }
  | { kind: "submenu"; text: string; items: MenuSpec[] };

export const STATUS_MARK: Record<PetStatus, string> = {
  needsInput: "🟡",
  blocked: "🔴",
  ready: "🟢",
  running: "🔵",
  idle: "⚪",
};

const MAX_SESSIONS = 20;

export interface PetMenuActions {
  focusSession: (sessionId: string) => void;
  selectBot: (botId: string) => void;
  createBot: () => void;
  selectPet: (petId: string) => void;
  openSettings: () => void;
  hide: () => void;
}

type T = TFunction<"ccchan">;

export function sessionMenu(entries: readonly SessionPetEntry[], t: T, actions: PetMenuActions): MenuSpec[] {
  if (entries.length === 0) return [{ kind: "item", text: t("menu.noSessions"), enabled: false }];
  return entries.slice(0, MAX_SESSIONS).map((entry) => ({
    kind: "item",
    text: `${STATUS_MARK[entry.status]} ${entry.title} · ${t(`status.${entry.status}`)}`,
    action: () => actions.focusSession(entry.sessionId),
  }));
}

export function botMenu(bots: readonly BotSummary[], activeId: string | null, t: T, actions: PetMenuActions): MenuSpec[] {
  const items: MenuSpec[] = bots.map((bot) => ({
    kind: "item",
    text: `${bot.avatar.trim() || "🤖"} ${bot.name}`,
    checked: bot.id === activeId,
    action: () => actions.selectBot(bot.id),
  }));
  if (items.length === 0) items.push({ kind: "item", text: t("menu.noBots"), enabled: false });
  items.push({ kind: "separator" }, { kind: "item", text: t("menu.createBot"), action: actions.createBot });
  return items;
}

export function petMenu(pets: readonly PetMeta[], currentPetId: string, actions: PetMenuActions): MenuSpec[] {
  return pets.map((pet) => ({
    kind: "item",
    text: pet.displayName,
    checked: pet.id === currentPetId,
    action: () => actions.selectPet(pet.id),
  }));
}

export function contextMenu(args: {
  bots: readonly BotSummary[];
  activeBotId: string | null;
  pets: readonly PetMeta[];
  currentPetId: string;
  entries: readonly SessionPetEntry[];
  t: T;
  actions: PetMenuActions;
}): MenuSpec[] {
  const { t, actions } = args;
  return [
    { kind: "submenu", text: t("menu.sessions"), items: sessionMenu(args.entries, t, actions) },
    { kind: "submenu", text: t("menu.switchBot"), items: botMenu(args.bots, args.activeBotId, t, actions) },
    { kind: "submenu", text: t("menu.changePet"), items: petMenu(args.pets, args.currentPetId, actions) },
    { kind: "separator" },
    { kind: "item", text: t("menu.settings"), action: actions.openSettings },
    { kind: "item", text: t("menu.hide"), action: actions.hide },
  ];
}

type MenuModule = typeof import("@tauri-apps/api/menu");
type NativeItem = Awaited<ReturnType<MenuModule["MenuItem"]["new"]>>
  | Awaited<ReturnType<MenuModule["CheckMenuItem"]["new"]>>
  | Awaited<ReturnType<MenuModule["PredefinedMenuItem"]["new"]>>
  | Awaited<ReturnType<MenuModule["Submenu"]["new"]>>;

async function buildItem(menu: MenuModule, spec: MenuSpec): Promise<NativeItem> {
  if (spec.kind === "separator") return menu.PredefinedMenuItem.new({ item: "Separator" });
  if (spec.kind === "submenu") {
    const items = await Promise.all(spec.items.map((item) => buildItem(menu, item)));
    return menu.Submenu.new({ text: spec.text, items });
  }
  const action = spec.action;
  const options = { text: spec.text, enabled: spec.enabled ?? true, action: action ? () => action() : undefined };
  if (spec.checked !== undefined) return menu.CheckMenuItem.new({ ...options, checked: spec.checked });
  return menu.MenuItem.new(options);
}

/** 在光标处弹出原生菜单；失败只告警（菜单不是关键路径）。 */
export async function popupMenu(specs: MenuSpec[]): Promise<void> {
  try {
    const module = await import("@tauri-apps/api/menu");
    const items = await Promise.all(specs.map((spec) => buildItem(module, spec)));
    const menu = await module.Menu.new({ items });
    await menu.popup();
  } catch (error) {
    console.warn("[ccchan] native menu failed:", error);
  }
}

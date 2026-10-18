import { create } from "zustand";
import type { CCChanSettings, PetMeta } from "@/ccchan/types";
import { invokeIfTauri, isTauriRuntime } from "@/services/runtime";

const fallbackSprite = `data:image/svg+xml;utf8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="none"/>
  <circle cx="32" cy="33" r="23" fill="#3b82f6"/>
  <circle cx="24" cy="29" r="4" fill="#ffffff"/>
  <circle cx="40" cy="29" r="4" fill="#ffffff"/>
  <path d="M24 43 Q32 49 40 43" stroke="#ffffff" stroke-width="4" fill="none" stroke-linecap="round"/>
</svg>
`)}`;

export const DEFAULT_CCCHAN_SETTINGS: CCChanSettings = {
  aiEngine: "claude",
  defaultPetId: "homie",
  // 宠物模块默认不打开：全新用户默认不自动显示、浮窗默认隐藏，
  // 需要时可从状态栏 cc酱 开关手动召出。
  autoStart: false,
  soundEnabled: true,
  windowVisible: false,
  windowX: null,
  windowY: null,
  // 随机漫游默认关闭：宠物待在原地，仍可拖拽。
  wanderEnabled: false,
  petSize: 120,
};

export const CCCHAN_PET_SIZE_MIN = 80;
export const CCCHAN_PET_SIZE_MAX = 240;
export const CCCHAN_PET_SIZE_DEFAULT = 120;

function clampPetSize(value: unknown): number {
  const size = Number(value);
  if (!Number.isFinite(size)) return CCCHAN_PET_SIZE_DEFAULT;
  return Math.min(CCCHAN_PET_SIZE_MAX, Math.max(CCCHAN_PET_SIZE_MIN, Math.round(size)));
}

export const FALLBACK_PET: PetMeta = {
  id: "homie",
  displayName: "cc酱",
  description: "Default CC-Panes mascot",
  spritesheetUrl: fallbackSprite,
  atlas: { cellW: 64, cellH: 64, cols: 1, rows: 1 },
  animations: {
    idle: { row: 0, frames: 1, fps: 1 },
    working: { row: 0, frames: 1, fps: 1 },
    waiting: { row: 0, frames: 1, fps: 1 },
    happy: { row: 0, frames: 1, fps: 1 },
    sad: { row: 0, frames: 1, fps: 1 },
  },
};

interface CCChanStoreState {
  settings: CCChanSettings;
  pets: PetMeta[];
  expanded: boolean;
  chatSessionId: string | null;
  loading: boolean;
  loaded: boolean;
  load: () => Promise<void>;
  saveSettings: (settings: CCChanSettings) => Promise<void>;
  /** 只更新内存（供跨窗口 settings 同步事件用），不回写后端。 */
  applySettings: (settings: Partial<CCChanSettings>) => void;
  applyPets: (pets: PetMeta[]) => void;
  setExpanded: (expanded: boolean) => void;
  setChatSessionId: (sessionId: string | null) => void;
  setWindowVisible: (visible: boolean) => void;
  setPosition: (x: number, y: number) => void;
  setDefaultPetId: (petId: string) => void;
  switchPet: () => Promise<void>;
}

export function normalizeCCChanSettings(
  settings: Partial<CCChanSettings> | null | undefined,
): CCChanSettings {
  const merged = { ...DEFAULT_CCCHAN_SETTINGS, ...settings };
  merged.petSize = clampPetSize(merged.petSize);
  merged.wanderEnabled = merged.wanderEnabled === true;
  return merged;
}

const normalizeSettings = normalizeCCChanSettings;

function normalizePets(pets: PetMeta[] | null | undefined): PetMeta[] {
  return pets && pets.length > 0 ? pets : [FALLBACK_PET];
}

let settingsRevision = 0;

export const useCCChanStore = create<CCChanStoreState>((set, get) => ({
  settings: DEFAULT_CCCHAN_SETTINGS,
  pets: [FALLBACK_PET],
  expanded: false,
  chatSessionId: null,
  loading: false,
  loaded: false,

  load: async () => {
    if (get().loading) return;
    set({ loading: true });
    const revision = settingsRevision;
    try {
      if (!isTauriRuntime()) {
        set({
          settings: DEFAULT_CCCHAN_SETTINGS,
          pets: [FALLBACK_PET],
          loaded: true,
        });
        return;
      }
      const [settings, pets] = await Promise.all([
        invokeIfTauri<CCChanSettings>("get_ccchan_settings").catch((error) => {
          console.warn("[ccchan] settings load failed:", error); return get().settings;
        }),
        invokeIfTauri<PetMeta[]>("get_ccchan_pets").catch((error) => {
          console.warn("[ccchan] pets load failed:", error); return get().pets;
        }),
      ]);
      set({
        settings: revision === settingsRevision ? normalizeSettings(settings) : get().settings,
        pets: normalizePets(pets),
        loaded: true,
      });
    } finally {
      set({ loading: false });
    }
  },

  saveSettings: async (settings) => {
    const normalized = normalizeSettings(settings);
    const revision = ++settingsRevision;
    await invokeIfTauri("save_ccchan_settings", { settings: normalized });
    if (revision === settingsRevision) set({ settings: normalized });
  },

  applySettings: (settings) => {
    settingsRevision++;
    set({ settings: normalizeSettings({ ...get().settings, ...settings }) });
  },

  applyPets: (pets) => set({ pets: normalizePets(pets) }),
  setExpanded: (expanded) => set({ expanded }),
  setChatSessionId: (sessionId) => set({ chatSessionId: sessionId }),
  setWindowVisible: (visible) => {
    settingsRevision++;
    set((state) => ({
      settings: { ...state.settings, windowVisible: visible },
    }));
  },
  setPosition: (x, y) => {
    settingsRevision++;
    set((state) => ({
      settings: { ...state.settings, windowX: x, windowY: y },
    }));
  },
  setDefaultPetId: (petId) => {
    set((state) => ({
      settings: { ...state.settings, defaultPetId: petId },
    }));
  },
  switchPet: async () => {
    const { pets, settings } = get();
    if (pets.length === 0) return;
    const currentIndex = Math.max(0, pets.findIndex((pet) => pet.id === settings.defaultPetId));
    const nextPet = pets[(currentIndex + 1) % pets.length];
    await get().saveSettings({ ...settings, defaultPetId: nextPet.id });
  },
}));

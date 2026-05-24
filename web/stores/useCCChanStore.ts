import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { CCChanSettings, PetMeta } from "@/ccchan/types";

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
  autoStart: true,
  soundEnabled: true,
  windowVisible: true,
  windowX: null,
  windowY: null,
};

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
  setExpanded: (expanded: boolean) => void;
  setChatSessionId: (sessionId: string | null) => void;
  setWindowVisible: (visible: boolean) => void;
  setPosition: (x: number, y: number) => void;
  setDefaultPetId: (petId: string) => void;
  switchPet: () => void;
}

function normalizeSettings(settings: Partial<CCChanSettings> | null | undefined): CCChanSettings {
  return { ...DEFAULT_CCCHAN_SETTINGS, ...settings };
}

function normalizePets(pets: PetMeta[] | null | undefined): PetMeta[] {
  return pets && pets.length > 0 ? pets : [FALLBACK_PET];
}

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
    try {
      const [settings, pets] = await Promise.all([
        invoke<CCChanSettings>("get_ccchan_settings").catch(() => DEFAULT_CCCHAN_SETTINGS),
        invoke<PetMeta[]>("get_ccchan_pets").catch(() => [FALLBACK_PET]),
      ]);
      set({
        settings: normalizeSettings(settings),
        pets: normalizePets(pets),
        loaded: true,
      });
    } finally {
      set({ loading: false });
    }
  },

  saveSettings: async (settings) => {
    const normalized = normalizeSettings(settings);
    await invoke("save_ccchan_settings", { settings: normalized });
    set({ settings: normalized });
  },

  setExpanded: (expanded) => set({ expanded }),
  setChatSessionId: (sessionId) => set({ chatSessionId: sessionId }),
  setWindowVisible: (visible) => {
    set((state) => ({
      settings: { ...state.settings, windowVisible: visible },
    }));
  },
  setPosition: (x, y) => {
    set((state) => ({
      settings: { ...state.settings, windowX: x, windowY: y },
    }));
  },
  setDefaultPetId: (petId) => {
    set((state) => ({
      settings: { ...state.settings, defaultPetId: petId },
    }));
  },
  switchPet: () => {
    const { pets, settings } = get();
    if (pets.length === 0) return;
    const currentIndex = Math.max(0, pets.findIndex((pet) => pet.id === settings.defaultPetId));
    const nextPet = pets[(currentIndex + 1) % pets.length];
    set((state) => ({
      settings: { ...state.settings, defaultPetId: nextPet.id },
    }));
  },
}));

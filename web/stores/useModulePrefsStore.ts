import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  MODULE_IDS,
  MODULE_REGISTRY,
  type ModuleId,
  type ModulePosition,
} from "@/modules/registry";

export interface ModulePreference {
  enabled: boolean;
  position: ModulePosition;
}

export type ModulePreferences = Record<ModuleId, ModulePreference>;
export type ModulePreset = "full" | "minimal";

interface ModulePrefsState {
  preferences: ModulePreferences;
  setEnabled: (id: ModuleId, enabled: boolean) => void;
  setPosition: (id: ModuleId, position: ModulePosition) => void;
  applyPreset: (preset: ModulePreset) => void;
}

export const MODULE_PREFS_STORAGE_KEY = "cc-panes-module-prefs";

export function createDefaultModulePreferences(): ModulePreferences {
  return Object.fromEntries(MODULE_IDS.map((id) => [
    id,
    { enabled: true, position: "activityBar" },
  ])) as ModulePreferences;
}

export function createModulePreferencesForPreset(preset: ModulePreset): ModulePreferences {
  return Object.fromEntries(MODULE_REGISTRY.map((module) => [
    module.id,
    {
      enabled: preset === "full" || module.minimal,
      position: module.defaultPosition,
    },
  ])) as ModulePreferences;
}

function isModulePosition(value: unknown): value is ModulePosition {
  return value === "activityBar" || value === "rightDock" || value === "hidden";
}

function normalizePreferences(value: unknown): ModulePreferences {
  const defaults = createDefaultModulePreferences();
  if (!value || typeof value !== "object") return defaults;
  const persisted = value as Partial<Record<ModuleId, Partial<ModulePreference>>>;

  for (const id of MODULE_IDS) {
    const preference = persisted[id];
    if (!preference || typeof preference !== "object") continue;
    defaults[id] = {
      enabled: typeof preference.enabled === "boolean" ? preference.enabled : true,
      position: isModulePosition(preference.position)
        ? preference.position
        : "activityBar",
    };
  }
  return defaults;
}

export const useModulePrefsStore = create<ModulePrefsState>()(
  persist(
    (set) => ({
      preferences: createDefaultModulePreferences(),
      setEnabled: (id, enabled) => set((state) => ({
        preferences: {
          ...state.preferences,
          [id]: { ...state.preferences[id], enabled },
        },
      })),
      setPosition: (id, position) => set((state) => ({
        preferences: {
          ...state.preferences,
          [id]: { ...state.preferences[id], position },
        },
      })),
      applyPreset: (preset) => set({
        preferences: createModulePreferencesForPreset(preset),
      }),
    }),
    {
      name: MODULE_PREFS_STORAGE_KEY,
      partialize: (state) => ({ preferences: state.preferences }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<ModulePrefsState>;
        return {
          ...currentState,
          preferences: normalizePreferences(persisted.preferences),
        };
      },
    },
  ),
);

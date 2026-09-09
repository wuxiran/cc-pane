// 技能 / MCP 介绍文案的展示语言。`auto` 跟随界面语言；用户手动切过就记住。
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DescriptionLocale } from "@/utils/localizedText";

export const DESCRIPTION_LANG_STORAGE_KEY = "cc-panes-description-lang";

export type DescriptionLangPreference = DescriptionLocale | "auto";

interface DescriptionLangState {
  preference: DescriptionLangPreference;
  setPreference: (preference: DescriptionLangPreference) => void;
}

export const useDescriptionLangStore = create<DescriptionLangState>()(
  persist(
    (set) => ({
      preference: "auto",
      setPreference: (preference) => set({ preference }),
    }),
    {
      name: DESCRIPTION_LANG_STORAGE_KEY,
      partialize: (state) => ({ preference: state.preference }),
    },
  ),
);

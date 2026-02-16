import { create } from "zustand";

type Theme = "light" | "dark";

const STORAGE_KEY = "theme";

interface ThemeState {
  isDark: boolean;
  toggleTheme: () => void;
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

// 初始化主题
const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
const initialTheme = stored ?? "light";
applyTheme(initialTheme);

export const useThemeStore = create<ThemeState>((set, get) => ({
  isDark: initialTheme === "dark",

  toggleTheme: () => {
    const next: Theme = get().isDark ? "light" : "dark";
    localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
    set({ isDark: next === "dark" });
  },
}));

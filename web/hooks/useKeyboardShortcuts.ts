import { useEffect } from "react";
import { handleKeydown } from "@/stores";

/**
 * 全局快捷键注册 hook
 */
export function useKeyboardShortcuts() {
  useEffect(() => {
    window.addEventListener("keydown", handleKeydown, true);
    return () => {
      window.removeEventListener("keydown", handleKeydown, true);
    };
  }, []);
}

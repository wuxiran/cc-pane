// 全局命令/快捷键注册：内置命令清单在 lib/commands/builtinCommands，
// 注册表把 handler 镜像进 useShortcutsStore 供键盘分发（见 lib/commands/registry.ts）。
import { useEffect } from "react";
import { useCommandsStore } from "@/lib/commands/registry";
import { buildBuiltinCommands } from "@/lib/commands/builtinCommands";

export function useShortcutRegistrations(): void {
  useEffect(() => {
    useCommandsStore.getState().registerCommands(buildBuiltinCommands());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

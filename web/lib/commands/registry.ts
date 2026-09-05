import { create } from "zustand";
import i18n from "@/i18n";
// 从 barrel 导入而非直达文件：barrel 内部按依赖序初始化各 store，
// 直达文件会在某些测试 import 顺序下让 useWallpaperStore 的模块级
// subscribe 抢到未初始化的 useSettingsStore（循环依赖）。
import { useShortcutsStore } from "@/stores";
import type { CommandContext, CommandDescriptor } from "./types";

interface CommandsState {
  commands: Map<string, CommandDescriptor>;
  registerCommands: (list: CommandDescriptor[]) => void;
  unregisterCommand: (id: string) => void;
}

// 项目的 i18next 类型按键名/命名空间强约束，命令标题跨命名空间动态解析，
// 需要宽松签名。组件侧靠 useTranslation 的语言订阅触发重渲染，无需把 t 传进来。
const translate: (key: string, options?: { ns?: string }) => string =
  i18n.t.bind(i18n) as unknown as (key: string, options?: { ns?: string }) => string;

export function resolveCommandTitle(cmd: CommandDescriptor): string {
  if (cmd.titleKey) return translate(cmd.titleKey, { ns: cmd.titleNs ?? "shortcuts" });
  return cmd.title ?? cmd.id;
}

/**
 * 命令注册中心：右键菜单 / 命令面板 / 工具栏的唯一动作来源。
 * 键盘分发仍走 useShortcutsStore（handleKeydown / shouldTerminalHandleKey
 * 行为不变），registerCommands 会把 handler/label/context 镜像过去。
 */
export const useCommandsStore = create<CommandsState>((set) => ({
  commands: new Map(),

  registerCommands: (list) => {
    set((state) => {
      const next = new Map(state.commands);
      for (const cmd of list) next.set(cmd.id, cmd);
      return { commands: next };
    });
    const shortcuts = useShortcutsStore.getState();
    for (const cmd of list) {
      shortcuts.registerAction({
        id: cmd.id,
        label: resolveCommandTitle(cmd),
        context: cmd.context,
        handler: () => void cmd.run({}),
      });
    }
  },

  unregisterCommand: (id) => {
    set((state) => {
      if (!state.commands.has(id)) return state;
      const next = new Map(state.commands);
      next.delete(id);
      return { commands: next };
    });
    useShortcutsStore.getState().unregisterAction(id);
  },
}));

/** 非组件环境（菜单回调、命令面板）按 id 执行命令；未注册或被 when 拦截时静默跳过。 */
export function runCommand(id: string, ctx: CommandContext = {}): void {
  const cmd = useCommandsStore.getState().commands.get(id);
  if (!cmd) return;
  if (cmd.when && !cmd.when(ctx)) return;
  void cmd.run(ctx);
}

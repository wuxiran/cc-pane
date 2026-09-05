// 右键菜单的命令渲染器：从命令注册中心取动作，自动带上当前键位（用户改键后同步变），
// 替代「菜单项各自接线 + 从不显示快捷键」的旧模式。命令未注册时渲染 null——
// 测试环境不跑 useShortcutRegistrations，菜单项自然消失而不是报错。
import { useTranslation } from "react-i18next";
import { ContextMenuItem, ContextMenuShortcut } from "@/components/ui/context-menu";
import { resolveCommandTitle, useCommandsStore } from "@/lib/commands/registry";
import { useSettingsStore } from "@/stores";
import { formatKeyCombo } from "@/stores/useShortcutsStore";
import type { CommandContext } from "@/lib/commands/types";

/** 菜单项右侧的键位提示；该命令没有绑定时不渲染。 */
export function CommandShortcutHint({ commandId }: { commandId: string }) {
  const binding = useSettingsStore((s) => s.settings?.shortcuts.bindings?.[commandId]);
  if (!binding) return null;
  return <ContextMenuShortcut>{formatKeyCombo(binding)}</ContextMenuShortcut>;
}

interface CommandMenuItemProps {
  commandId: string;
  /** 显式目标（如右键的 pane/tab）；缺省由命令内部回落到激活目标。 */
  ctx?: CommandContext;
  /** 菜单内文案与全局命令标题不同（如「面板 · 拆分到右侧」）时覆盖。 */
  label?: string;
  inset?: boolean;
  variant?: "default" | "destructive";
}

export default function CommandMenuItem({ commandId, ctx, label, inset, variant }: CommandMenuItemProps) {
  const cmd = useCommandsStore((s) => s.commands.get(commandId));
  // 订阅语言切换触发重渲染；标题解析见 resolveCommandTitle 的说明
  useTranslation();
  if (!cmd) return null;
  const disabled = cmd.when ? !cmd.when(ctx ?? {}) : false;
  const Icon = cmd.icon;
  return (
    <ContextMenuItem
      inset={inset ?? !Icon}
      variant={variant}
      disabled={disabled}
      onSelect={() => void cmd.run(ctx ?? {})}
    >
      {Icon ? <Icon /> : null}
      {label ?? resolveCommandTitle(cmd)}
      <CommandShortcutHint commandId={commandId} />
    </ContextMenuItem>
  );
}

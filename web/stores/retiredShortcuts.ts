/**
 * 已下线的快捷键 action：老配置可能还存着它们的绑定（迷你模式已删除）。
 * 读入时剔除，避免设置页出现无标签的孤儿行、按键冲突检测误报（如 Ctrl+M）。
 * Rust 侧 `ShortcutSettings::merge_missing_defaults` 同口径剔除。
 */
const RETIRED_SHORTCUT_ACTIONS: readonly string[] = ["toggle-mini-mode"];

export function stripRetiredShortcutBindings(
  bindings: Record<string, string> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(bindings ?? {}).filter(
      ([actionId]) => !RETIRED_SHORTCUT_ACTIONS.includes(actionId),
    ),
  );
}

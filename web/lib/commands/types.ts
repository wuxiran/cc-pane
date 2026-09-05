import type { LucideIcon } from "lucide-react";
import type { SplitDirection } from "@/types";

/**
 * 命令分组：命令面板按组展示，后续速查表（Ctrl+/）也按它分节。
 */
export type CommandGroupId = "tab" | "layout" | "terminal" | "view" | "system";

/**
 * 菜单/按钮触发时传入的显式目标；键盘触发为空对象，
 * 命令内部自行回落到激活 pane/tab（与快捷键旧行为一致）。
 */
export interface CommandContext {
  paneId?: string;
  tabId?: string;
  /** 分屏方向参数（如 split-clone-tab 用同一命令承载右/下两个菜单项）。 */
  direction?: SplitDirection;
}

/**
 * 命令注册中心的动作定义：右键菜单、命令面板、快捷键、工具栏四处共用同一份。
 * 新增动作只注册一次，各入口自动获得（菜单项自动显示当前键位）。
 */
export interface CommandDescriptor {
  /** 与快捷键绑定表（settings.shortcuts.bindings）共用同一 id。 */
  id: string;
  /** i18n key；缺省回落 title，再缺省 id。 */
  titleKey?: string;
  /** i18n 命名空间，默认 "shortcuts"。 */
  titleNs?: string;
  /** 非 i18n 的标题（含插值的动态标题在构建时求值好放这里）。 */
  title?: string;
  icon?: LucideIcon;
  group: CommandGroupId;
  /** 与快捷键分发层语义一致："terminal" = 仅终端聚焦时生效。 */
  context?: "global" | "terminal";
  /** 命令面板里不列出（如 switch-tab-1..9 系列，只能从键位触发）。 */
  hiddenFromPalette?: boolean;
  /** 可用性判断；菜单项据此置灰。 */
  when?: (ctx: CommandContext) => boolean;
  run: (ctx: CommandContext) => void | Promise<void>;
}

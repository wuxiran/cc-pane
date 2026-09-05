import type { CommandGroupId } from "./types";

/** 命令分组的展示顺序与标题 key（命令面板与速查表共用，shortcuts 命名空间）。 */
export const COMMAND_GROUP_ORDER: CommandGroupId[] = ["tab", "layout", "terminal", "view", "system"];

export const COMMAND_GROUP_HEADING_KEYS: Record<CommandGroupId, string> = {
  tab: "commandGroupTabs",
  layout: "commandGroupLayoutOps",
  terminal: "commandGroupTerminal",
  view: "commandGroupView",
  system: "commandGroupSystem",
};

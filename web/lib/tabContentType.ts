// Tab 内容类型的唯一集中映射表。
//
// `Tab.contentType` 是内联在 `web/types/terminal.ts` 上的联合字面量，此前既没有命名
// 类型也没有任何集中映射：图标散落在 TabBar（只有 browser 有）、文字散落在移动端
// 原型的 tabKindLabel。这里一次性收口，新增 contentType 时**必须**同步本文件的两张
// 表（TAB_CONTENT_GROUP / TAB_CONTENT_ICON），`tabContentType.test.ts` 会穷举断言。
import { Bot, FileText, FolderTree, Globe2, MessagesSquare, Settings2, Terminal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Tab } from "@/types";

export type TabContentType = Tab["contentType"];

/**
 * 布局卡片上的四桁分组。
 * 终端 / 浏览器 / 文件（单文件编辑器 + 目录树）/ 工具（三个管理面板）。
 * 分成四桁而不是三桁，是为了让各桁之和 === tab 总数——否则卡片顶部写 5、
 * 下面加起来是 3，用户无从判断少的那两个去哪了。
 */
export type TabContentGroup = "terminal" | "browser" | "files" | "tools";

export const TAB_CONTENT_GROUPS: readonly TabContentGroup[] = [
  "terminal",
  "browser",
  "files",
  "tools",
] as const;

export const TAB_CONTENT_GROUP: Record<TabContentType, TabContentGroup> = {
  terminal: "terminal",
  browser: "browser",
  // dsh 归 terminal 而非 browser：它承载的是一个 agent 会话，只是恰好用
  // 浏览器渲染（dsh 没有 TUI，界面就是 Web UI）。归 browser 会让卡片上的
  // 「N 个网页」把一个正在干活的 agent 说成一张网页。
  dsh: "terminal",
  // agent-chat 同理归 terminal：它是一个正在干活的 agent 会话（ACP 结构化
  // 渲染），不是网页也不是文件。
  "agent-chat": "terminal",
  editor: "files",
  "file-explorer": "files",
  "mcp-config": "tools",
  "skill-manager": "tools",
  "memory-manager": "tools",
};

/**
 * 图标沿用仓库既有的事实约定，不另起一套：
 * 终端 `Terminal`（PanelEmptyState / TerminalTabContent），
 * 浏览器 `Globe2`（**不是 Globe**，TabBar 一直用的是 Globe2），
 * 目录树 `FolderTree`（TabBar 的 revealInExplorer），
 * 单文件 `FileText`（panes 目录下此前未使用的空位）。
 */
export const TAB_CONTENT_ICON: Record<TabContentType, LucideIcon> = {
  terminal: Terminal,
  browser: Globe2,
  // 与终端同组但用不同图标：它在标签栏里要能与普通终端一眼区分。
  dsh: Bot,
  "agent-chat": MessagesSquare,
  editor: FileText,
  "file-explorer": FolderTree,
  "mcp-config": Settings2,
  "skill-manager": Settings2,
  "memory-manager": Settings2,
};

/** 分组代表图标（布局卡片的类型计数桁用） */
export const TAB_GROUP_ICON: Record<TabContentGroup, LucideIcon> = {
  terminal: Terminal,
  browser: Globe2,
  files: FileText,
  tools: Settings2,
};

/**
 * i18n key（panes 命名空间），供计数桁的 aria-label / title 使用。
 * `as const` 不可省——i18next 的 t() 是字面量联合类型，宽化成 string 会编译失败。
 */
export const TAB_GROUP_LABEL_KEY = {
  terminal: "tabGroupTerminal",
  browser: "tabGroupBrowser",
  files: "tabGroupFiles",
  tools: "tabGroupTools",
} as const satisfies Record<TabContentGroup, string>;

export function tabContentGroup(contentType: TabContentType): TabContentGroup {
  return TAB_CONTENT_GROUP[contentType];
}

// Tab 唯一构造点（docs/78 批4）。
//
// 改道前 7 种 contentType 里有 6 种是在各自的 action 里内联字面量构造的：新增
// 一个必填字段（例如 batch1 的回收所需字段）要挨个找齐，漏一处就是一个「长得像
// tab 但少半截」的对象，而**类型层看不出来**（Tab 的字段大多可选）。
//
// 现在构造只有一条路：公共底座（id/title/contentType/project*/sessionId）+ 登记表
// 里该类型的 `createDefaults`。新增 contentType 时登记表的穷举测试会逼着补默认值。
//
// 注意：本模块**不做落位**（push 进哪个 pane、activeTabId 怎么收敛）——那是各
// action 自己的语义，收敛的只是「一个 tab 长什么样」。
import { generateId } from "@/lib/paneTree";
import type { TabContentType } from "@/lib/tabContentType";
import type { Tab } from "@/types";
import type { CreateTabOptions } from "@/stores/panesStoreTypes";
import { TAB_LIFECYCLE } from "./registry";

/**
 * 各 contentType 的构造入参并集。
 *
 * 合并成一个而不是判别联合：调用点全是「已知类型 + 少量字段」的形态，联合带来的
 * 收窄噪音大于收益；类型正确性由 `createDefaults` 各自挑字段保证。
 */
export interface TabCreateInput {
  /** 调用方自带 id（browser 的 openBrowser 允许指定，webview 键与 tabId 同源）。 */
  id?: string;
  title?: string;
  projectId?: string;
  projectPath?: string;
  /** browser：初始 URL。 */
  browserUrl?: string;
  /** editor：文件绝对路径。 */
  filePath?: string;
  /** dsh：所属工作空间路径——决定复用哪个 dsh 实例。 */
  workspacePath?: string;
  /** skill-manager（工作空间作用域）等：所属工作空间名。 */
  workspaceName?: string;
  /** terminal：启动身份全集（原 createTab 的入参）。 */
  terminal?: CreateTabOptions;
}

/** 与 contentType 无关的公共字段。 */
function baseTab(contentType: TabContentType, input: TabCreateInput): Tab {
  return {
    id: input.id || generateId("tab"),
    title: input.title ?? "",
    contentType,
    projectId: input.projectId ?? "",
    projectPath: input.projectPath ?? "",
    sessionId: null,
    ...(input.workspaceName ? { workspaceName: input.workspaceName } : {}),
  };
}

/** 唯一构造点。落位与去重由调用方负责。 */
export function createTabOfType(
  contentType: TabContentType,
  input: TabCreateInput = {},
): Tab {
  return {
    ...baseTab(contentType, input),
    ...TAB_LIFECYCLE[contentType].createDefaults(input),
  };
}

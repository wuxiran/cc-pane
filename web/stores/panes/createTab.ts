// 终端标签工厂包装。真身在 `lib/tabLifecycle/tabFactory` + 登记表的 createDefaults
// （docs/78 批4：Tab 构造收敛成唯一入口）。从 usePanesStore.ts 拆出（纯代码移动），
// usePanesStore 仍 re-export 维持既有 import 路径。
import type { Tab } from "@/types";
import { createTabOfType } from "@/lib/tabLifecycle/tabFactory";
import type { CreateTabOptions } from "../panesStoreTypes";

/**
 * 终端标签工厂。真身在 `lib/tabLifecycle/tabFactory` + 登记表的 createDefaults
 * （docs/78 批4：Tab 构造收敛成唯一入口），这里保留既有调用签名与 import 路径。
 */
export function createTab(opts: CreateTabOptions): Tab {
  return createTabOfType("terminal", {
    // 调用方预分配的出生锚点优先（后端派发的会话已把它写进不可变凭证）；
    // 不传时由 baseTab 生成，行为与以前一致。
    id: opts.tabId,
    projectId: opts.projectId,
    projectPath: opts.projectPath,
    terminal: opts,
  });
}

# -*- coding: utf-8 -*-
import io

def rw(p):
    return io.open(p, encoding='utf-8').read()

def wr(p, s):
    io.open(p, 'w', encoding='utf-8').write(s)

def sub(s, old, new, p):
    assert old in s, "MISS in %s: %r" % (p, old[:90])
    return s.replace(old, new, 1)

# ---------- paneTree.ts ----------
p = 'web/lib/paneTree.ts'
s = rw(p)

helpers = '''
/** split 的 sizes 重归一化到 100（splice 后调用；全零时按 children 均分）。 */
export function normalizeSplitSizes(node: { sizes: number[]; children: unknown[] }): void {
  const total = node.sizes.reduce((sum, size) => sum + size, 0);
  node.sizes = total > 0
    ? node.sizes.map((size) => (size / total) * 100)
    : node.children.map(() => 100 / node.children.length);
}

/**
 * splice 后收敛：把新树写回持有者并把 activePaneId 落到首个 panel。
 *
 * holder 既可以是 store 工作副本（state），也可以是隐藏布局条目（layout）——
 * 两者结构同形（rootPane + activePaneId），这正是此前 8 处逐字副本的由来。
 */
export function assignTreeAndConvergeActive(
  holder: { rootPane: PaneNode; activePaneId: string },
  nextTree: PaneNode,
): void {
  holder.rootPane = nextTree;
  const activePane = findPane(holder.rootPane, holder.activePaneId);
  if (activePane?.type !== "panel") {
    holder.activePaneId = collectPanels(holder.rootPane)[0]?.id ?? holder.rootPane.id;
  }
}

/**
 * 逐布局遍历**含星标**（与消费侧 eachLayoutTree 的关键区别）：销毁/移除类
 * 操作必须扫星标布局——镜像标签同样要能移除，否则星标布局里的标签永远
 * 关不掉。当前布局的活树取工作副本 rootPane（layouts[i].rootPane 是旧的）。
 */
export function eachLayoutTreeWithStarred<L extends { id: string; rootPane?: PaneNode }>(
  state: { layouts: L[]; currentLayoutId: string; rootPane: PaneNode },
  fn: (tree: PaneNode, layout: L, isCurrent: boolean) => void,
): void {
  for (const layout of state.layouts) {
    const isCurrent = layout.id === state.currentLayoutId;
    const tree = isCurrent ? state.rootPane : layout.rootPane;
    if (!tree) continue;
    fn(tree, layout, isCurrent);
  }
}
'''
s = s.rstrip('\n') + '\n' + helpers

s = sub(s, '''  const total = root.sizes.reduce((sum, size) => sum + size, 0);
  root.sizes = total > 0
    ? root.sizes.map((size) => (size / total) * 100)
    : root.children.map(() => 100 / root.children.length);
''', '''  normalizeSplitSizes(root);
''', p)
s = sub(s, '''  parent.sizes.splice(parentResult.index, 1);
  const total = parent.sizes.reduce((sum, size) => sum + size, 0);
  parent.sizes = total > 0
    ? parent.sizes.map((size) => (size / total) * 100)
    : parent.sizes.map(() => 100 / parent.sizes.length);
''', '''  parent.sizes.splice(parentResult.index, 1);
  normalizeSplitSizes(parent);
''', p)
s = sub(s, '''  const total = parent.sizes.reduce((sum, size) => sum + size, 0);
  parent.sizes = total > 0
    ? parent.sizes.map((size) => (size / total) * 100)
    : parent.children.map(() => 100 / parent.children.length);
''', '''  normalizeSplitSizes(parent);
''', p)
wr(p, s)
print('paneTree ok')

# ---------- paneRemovalActions ----------
p = 'web/stores/paneRemovalActions.ts'
s = rw(p)
s = sub(s, '''            const nextTree = closeTabInTree(tree, panel.id, tabId, true);
            if (isCurrent) {
              state.rootPane = nextTree;
              const activePane = findPane(state.rootPane, state.activePaneId);
              if (activePane?.type !== "panel") {
                state.activePaneId = collectPanels(state.rootPane)[0]?.id ?? state.rootPane.id;
              }
            } else {
              layout.rootPane = nextTree;
              const activePane = findPane(layout.rootPane, layout.activePaneId);
              if (activePane?.type !== "panel") {
                layout.activePaneId = collectPanels(layout.rootPane)[0]?.id ?? layout.rootPane.id;
              }
            }''',
'''            const nextTree = closeTabInTree(tree, panel.id, tabId, true);
            assignTreeAndConvergeActive(isCurrent ? state : layout, nextTree);''', p)
s = sub(s, '''        const total = parent.sizes.reduce((a, b) => a + b, 0);
        parent.sizes = total > 0
          ? parent.sizes.map((s) => (s / total) * 100)
          : parent.sizes.map(() => 100 / parent.sizes.length);
''', '''        normalizeSplitSizes(parent);
''', p)
s = sub(s, '''import {
  closeTabInTree,''', '''import {
  assignTreeAndConvergeActive,
  closeTabInTree,''', p)
s = sub(s, '''  normalizePaneTree,
  notifyTerminalLayoutChanged,
} from "@/lib/paneTree";''', '''  normalizePaneTree,
  normalizeSplitSizes,
  notifyTerminalLayoutChanged,
} from "@/lib/paneTree";''', p)
wr(p, s)
print('paneRemovalActions ok')

# ---------- backendCloseActions ----------
p = 'web/stores/backendCloseActions.ts'
s = rw(p)
s = sub(s, '''          const nextTree = closeTabInTree(tree, panel.id, tab.id, true);
          if (isCurrent) {
            state.rootPane = nextTree;
            const activePane = findPane(state.rootPane, state.activePaneId);
            if (activePane?.type !== "panel") {
              state.activePaneId = collectPanels(state.rootPane)[0]?.id ?? state.rootPane.id;
            }
          } else {
            layout.rootPane = nextTree;
            const activePane = findPane(layout.rootPane, layout.activePaneId);
            if (activePane?.type !== "panel") {
              layout.activePaneId = collectPanels(layout.rootPane)[0]?.id ?? layout.rootPane.id;
            }
          }''',
'''          const nextTree = closeTabInTree(tree, panel.id, tab.id, true);
          assignTreeAndConvergeActive(isCurrent ? state : layout, nextTree);''', p)
s = sub(s, 'import { closeTabInTree, collectPanels, findPane } from "@/lib/paneTree";',
        'import { assignTreeAndConvergeActive, closeTabInTree, collectPanels } from "@/lib/paneTree";', p)
wr(p, s)
print('backendClose ok')

# ---------- usePanesStore removeTerminalLaunch ----------
p = 'web/stores/usePanesStore.ts'
s = rw(p)
s = sub(s, '''        const isCurrent = location.layoutId === state.currentLayoutId;
        const nextTree = closeTabInTree(location.tree, location.panel.id, tabId);
        if (isCurrent) {
          state.rootPane = nextTree;
          const activePane = findPane(state.rootPane, state.activePaneId);
          if (activePane?.type !== "panel") {
            state.activePaneId = collectPanels(state.rootPane)[0]?.id ?? state.rootPane.id;
          }
        } else {
          const layout = state.layouts.find((item) => item.id === location.layoutId);
          if (!layout) return;
          layout.rootPane = nextTree;
          const activePane = findPane(layout.rootPane, layout.activePaneId);
          if (activePane?.type !== "panel") {
            layout.activePaneId = collectPanels(layout.rootPane)[0]?.id ?? layout.rootPane.id;
          }
        }''',
'''        const isCurrent = location.layoutId === state.currentLayoutId;
        const nextTree = closeTabInTree(location.tree, location.panel.id, tabId);
        const holder = isCurrent
          ? state
          : state.layouts.find((item) => item.id === location.layoutId);
        if (!holder) return;
        assignTreeAndConvergeActive(holder, nextTree);''', p)
if 'assignTreeAndConvergeActive' not in s.split('} from "@/lib/paneTree";')[0].split('import {')[-1]:
    s = sub(s, 'import { collectTabs, collectTerminalLeaves, findTerminalPane } from "@/lib/paneSessions";',
            'import { collectTabs, collectTerminalLeaves, findTerminalPane } from "@/lib/paneSessions";\nimport { assignTreeAndConvergeActive } from "@/lib/paneTree";', p)
wr(p, s)
print('usePanesStore ok')

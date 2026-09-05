// 分屏结构 actions：split / openSessionBesidePane / 布局预设 / resize。
// 从 usePanesStore.ts 拆出（纯代码移动，逻辑不变）；在 usePanesStore 里 spread 挂载。
import {
  collectPanels,
  createPanel,
  findPane,
  findParent,
  generateId,
  notifyTerminalLayoutChanged,
} from "@/lib/paneTree";
import type { Panel, SplitDirection, SplitPane, Tab } from "@/types";
import { activateFirstNormalLayout, resolveLayoutWriteTarget } from "../paneLayoutHelpers";
import type { PanesState } from "../panesStoreTypes";
import { createTab } from "./createTab";
import {
  buildPresetTree,
  LAYOUT_PRESET_SLOTS,
  resolveAutoDirection,
} from "./layoutPresets";
import type { PanesStoreAccess } from "./storeAccess";

export type SplitActions = Pick<
  PanesState,
  | "split"
  | "splitRight"
  | "splitDown"
  | "openSessionBesidePane"
  | "applyLayoutPreset"
  | "resizePanes"
>;

export function createSplitActions({ set, get }: PanesStoreAccess): SplitActions {
  return {
    split: (paneId, direction) => {
      const directionMap: Record<SplitDirection, "horizontal" | "vertical"> = {
        right: "horizontal",
        down: "vertical",
      };
      const splitDirection = directionMap[direction];

      set((state) => {
        const parentResult = findParent(state.rootPane, paneId);
        if (!parentResult) return;

        const targetPane = findPane(state.rootPane, paneId);
        if (!targetPane || targetPane.type !== "panel") return;

        const newPane = createPanel();

        if (parentResult.parent === null) {
          const newSplit: SplitPane = {
            type: "split",
            id: generateId("split"),
            direction: splitDirection,
            children: [targetPane, newPane],
            sizes: [50, 50],
          };
          state.rootPane = newSplit;
        } else {
          const parent = parentResult.parent;
          const index = parentResult.index;

          if (parent.children.length === 1) {
            // 单 child 壳：直接改造壳（换方向 + 插入新 pane），不再包一层新 split，
            // 否则父 SplitView 中 key 变化会 remount 幸存终端。
            parent.direction = splitDirection;
            parent.children.push(newPane);
            parent.sizes = [50, 50];
          } else if (parent.direction === splitDirection) {
            parent.children.splice(index + 1, 0, newPane);
            const newSize = 100 / parent.children.length;
            parent.sizes = parent.children.map(() => newSize);
          } else {
            const newSplit: SplitPane = {
              type: "split",
              id: generateId("split"),
              direction: splitDirection,
              children: [targetPane, newPane],
              sizes: [50, 50],
            };
            parent.children[index] = newSplit;
          }
        }

        state.activePaneId = newPane.id;
      });
      notifyTerminalLayoutChanged("pane.split");
    },

    splitRight: (paneId) => get().split(paneId, "right"),
    splitDown: (paneId) => get().split(paneId, "down"),

    openSessionBesidePane: (paneId, direction, opts, layoutId) => {
      const directionMap: Record<SplitDirection, "horizontal" | "vertical"> = {
        right: "horizontal",
        down: "vertical",
      };

      set((state) => {
        const target = resolveLayoutWriteTarget(state, layoutId);
        if (!target) return;
        const tree = target.tree;

        // auto 的解析必须针对**目标布局**那棵树（以前是靠先切布局保证的）。
        const resolvedDirection =
          direction === "auto" ? resolveAutoDirection(tree, paneId) : direction;
        const splitDirection = directionMap[resolvedDirection];

        const targetPane = findPane(tree, paneId);
        const parentResult = findParent(tree, paneId);

        // 无法在该 pane 旁分屏（未找到 / 不是 panel / 找不到父）→ 退化为在该 pane
        // （或首个 panel）加标签，保证会话总能落地。
        if (!targetPane || targetPane.type !== "panel" || !parentResult) {
          const fallback =
            targetPane?.type === "panel" ? targetPane : collectPanels(tree)[0];
          if (!fallback) return;
          const tab = createTab(opts);
          fallback.tabs.push(tab);
          fallback.activeTabId = tab.id;
          target.setActivePaneId(fallback.id);
          return;
        }

        // 目标 pane 本就是空的（如新建布局的空窗格）→ 直接把会话开在里面，
        // 不必分裂出一个多余的空窗格。
        if (targetPane.tabs.length === 0) {
          const tab = createTab(opts);
          targetPane.tabs.push(tab);
          targetPane.activeTabId = tab.id;
          target.setActivePaneId(targetPane.id);
          return;
        }

        // 新窗格：建好就把新会话作为其唯一（激活）标签，避免先空屏再落会话。
        // 必须把会话标签传给 createPanel——无参调用会自带一个默认 "Terminal" 空标签。
        const newPane = createPanel(createTab(opts));

        // 插入 newPane 到 targetPane 旁边（复刻 split 的插入逻辑）。
        if (parentResult.parent === null) {
          target.setRoot({
            type: "split",
            id: generateId("split"),
            direction: splitDirection,
            children: [targetPane, newPane],
            sizes: [50, 50],
          });
        } else {
          const parent = parentResult.parent;
          const index = parentResult.index;
          if (parent.children.length === 1) {
            parent.direction = splitDirection;
            parent.children.push(newPane);
            parent.sizes = [50, 50];
          } else if (parent.direction === splitDirection) {
            parent.children.splice(index + 1, 0, newPane);
            const newSize = 100 / parent.children.length;
            parent.sizes = parent.children.map(() => newSize);
          } else {
            const newSplit: SplitPane = {
              type: "split",
              id: generateId("split"),
              direction: splitDirection,
              children: [targetPane, newPane],
              sizes: [50, 50],
            };
            parent.children[index] = newSplit;
          }
        }

        target.setActivePaneId(newPane.id);
      });
      get().autoBindLayoutWorkspaceFromTabs();
      // 只有动了当前布局才需要让在屏终端 refit；改别的布局的树不影响当前渲染
      if (!layoutId || layoutId === get().currentLayoutId) {
        notifyTerminalLayoutChanged("pane.split");
      }
    },

    applyLayoutPreset: (preset) => {
      set((state) => {
        if (!activateFirstNormalLayout(state)) return;

        const slotCount = LAYOUT_PRESET_SLOTS[preset];
        const existingPanels = collectPanels(state.rootPane);
        const allTabs = existingPanels.flatMap((panel) => panel.tabs);

        // 记住重排前的激活 tab，重排后把焦点跟过去
        const prevActivePane = findPane(state.rootPane, state.activePaneId);
        const prevActiveTabId =
          prevActivePane?.type === "panel" ? prevActivePane.activeTabId : null;
        // 各 panel 的 activeTabId 集合：tab 被分走后优先保持原激活标签仍激活
        const prevActiveTabIds = new Set(
          existingPanels.map((panel) => panel.activeTabId)
        );

        // 顺序填充：前 N-1 格各一个 tab，剩余全部进最后一格；tabs 不足则留空格子
        const slotTabs: Tab[][] = Array.from({ length: slotCount }, () => []);
        allTabs.forEach((tab, index) => {
          slotTabs[Math.min(index, slotCount - 1)].push(tab);
        });

        // 复用现有 Panel id（按序），保住 React key 减少幸存终端 remount。
        // tabs 不足的格子留成空 Panel（tabs: []）：Panel.tsx 对无 activeTab 渲染
        // 空状态，openSessionBesidePane / addTab 均支持往空 pane 落会话。
        const slots: Panel[] = slotTabs.map((tabs, index) => {
          const reused = existingPanels[index];
          const active =
            tabs.find((tab) => reused && tab.id === reused.activeTabId)
            ?? tabs.find((tab) => prevActiveTabIds.has(tab.id))
            ?? tabs[0];
          return {
            type: "panel",
            id: reused?.id ?? generateId("pane"),
            tabs,
            activeTabId: active?.id ?? "",
          };
        });

        const rootSplitId = state.rootPane.type === "split" ? state.rootPane.id : null;
        state.rootPane = buildPresetTree(preset, slots, rootSplitId);

        const focusSlot =
          (prevActiveTabId
            && slots.find((slot) => slot.tabs.some((tab) => tab.id === prevActiveTabId)))
          || slots[0];
        state.activePaneId = focusSlot.id;
      });
      notifyTerminalLayoutChanged("layout.preset");
    },

    resizePanes: (paneId, sizes) => {
      set((state) => {
        const pane = findPane(state.rootPane, paneId);
        if (pane?.type === "split") {
          pane.sizes = sizes;
        }
      });
      notifyTerminalLayoutChanged("pane.resize");
    },
  };
}

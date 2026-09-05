// 内置命令清单：从原 useShortcutRegistrations 平移，行为保持不变。
// 差异只有两点：split-right/split-down 支持 ctx.paneId 显式目标（右键菜单触发时
// 作用于目标 pane 而非激活 pane）；show-explorer/sessions/files 补上 i18n 标题。
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Command as CommandIcon,
  CopyPlus,
  Equal,
  Expand,
  FolderOpen,
  FolderTree,
  History,
  LayoutGrid,
  Maximize2,
  MessagesSquare,
  Mic,
  Minimize2,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Plus,
  RotateCcw,
  Settings,
  X,
  XCircle,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { toastErr } from "@/lib/feedback";
import {
  usePanesStore,
  useFullscreenStore,
  useMiniModeStore,
  useDialogStore,
  useActivityBarStore,
  useVoiceInputStore,
  useSettingsStore,
  TERMINAL_FONT_SIZE_DEFAULT,
} from "@/stores";
import { LAYOUT_BAR_TOGGLE_EVENT } from "@/components/LayoutBar";
import { COMMAND_PALETTE_TOGGLE_EVENT } from "@/components/CommandPalette";
import { CLOSE_ACTIVE_TAB_EVENT } from "@/components/panes/useTabClosing";
import { findPaneFocusTarget, readPaneFocusRects, type PaneFocusDirection } from "@/utils/paneFocus";
import { buildDeepFeatureCommands } from "./deepFeatureCommands";
import { resolvePaneTab } from "./resolveTarget";
import i18n from "@/i18n";
import type { TerminalPaneLeaf, TerminalPaneNode } from "@/types";
import type { LayoutPresetId } from "@/types/pane";
import type { CommandDescriptor } from "./types";

function findTerminalLeaf(node: TerminalPaneNode, paneId: string): TerminalPaneLeaf | null {
  if (node.type === "leaf") return node.id === paneId ? node : null;
  for (const child of node.children) {
    const found = findTerminalLeaf(child, paneId);
    if (found) return found;
  }
  return null;
}

function firstTerminalLeaf(node: TerminalPaneNode): TerminalPaneLeaf | null {
  if (node.type === "leaf") return node;
  for (const child of node.children) {
    const found = firstTerminalLeaf(child);
    if (found) return found;
  }
  return null;
}

function focusPane(direction: PaneFocusDirection): void {
  const s = usePanesStore.getState();
  const paneOrder = s.allPanels().map((pane) => pane.id);
  const targetPaneId = findPaneFocusTarget({
    activePaneId: s.activePaneId,
    direction,
    paneOrder,
    paneRects: readPaneFocusRects(),
  });
  if (targetPaneId && targetPaneId !== s.activePaneId) {
    s.setActivePane(targetPaneId);
  }
}

function requestVoiceInput(): void {  const s = usePanesStore.getState();
  const pane = s.findPaneById(s.activePaneId);
  if (!pane || pane.type !== "panel") {
    toastErr(i18n.t("voiceUnavailable", { ns: "panes" }));
    return;
  }
  const tab = pane.tabs.find((item) => item.id === pane.activeTabId);
  if (!tab || tab.contentType !== "terminal" || !tab.terminalRootPane) {
    toastErr(i18n.t("voiceUnavailable", { ns: "panes" }));
    return;
  }
  const activeLeaf = tab.activeTerminalPaneId
    ? findTerminalLeaf(tab.terminalRootPane, tab.activeTerminalPaneId)
    : null;
  const leaf = activeLeaf ?? firstTerminalLeaf(tab.terminalRootPane);
  if (!leaf?.sessionId) {
    toastErr(i18n.t("voiceNoSession", { ns: "panes" }));
    return;
  }
  if (leaf.disconnected || leaf.restoring) {
    toastErr(i18n.t("voiceUnavailable", { ns: "panes" }));
    return;
  }
  useVoiceInputStore.getState().requestToggle(`${leaf.id}:${leaf.sessionId}`);
}

// 工厂而非模块级常量：i18n.t 在注册时（App effect 里）求值，与旧实现时机一致。
export function buildBuiltinCommands(): CommandDescriptor[] {
  const commands: CommandDescriptor[] = [
    {
      id: "toggle-sidebar",
      titleKey: "toggle-sidebar",
      icon: PanelLeft,
      group: "view",
      run: () => useActivityBarStore.getState().toggleSidebar(),
    },
    {
      id: "toggle-fullscreen",
      titleKey: "toggle-fullscreen",
      icon: Maximize2,
      group: "view",
      run: () => useFullscreenStore.getState().toggleFullscreen(),
    },
    {
      id: "new-tab",
      titleKey: "new-tab",
      icon: Plus,
      group: "tab",
      // 新建标签走全局启动器（项目/CLI/环境/参数一站式选择）
      run: () => useDialogStore.getState().openLauncher(),
    },
    {
      id: "close-tab",
      titleKey: "close-tab",
      icon: X,
      group: "tab",
      // 交给激活面板执行，与鼠标点 × 同一条路径：pinned 保护、dirty 确认、
      // 分屏标签全量 kill 都在 Panel.handleCloseTab 里，这里不再复制一份。
      run: () => window.dispatchEvent(new Event(CLOSE_ACTIVE_TAB_EVENT)),
    },
    {
      id: "reopen-closed-tab",
      titleKey: "reopen-closed-tab",
      icon: History,
      group: "tab",
      // 无已关闭标签时 reopenClosedTab 自身就是 no-op，这里不重复判断。
      run: (ctx) => {
        const s = usePanesStore.getState();
        s.reopenClosedTab(ctx.paneId ?? s.activePaneId);
      },
    },
    {
      id: "settings",
      titleKey: "settings",
      icon: Settings,
      group: "system",
      run: () => useDialogStore.getState().openSettings(),
    },
    {
      id: "command-palette",
      titleKey: "command-palette",
      icon: CommandIcon,
      group: "system",
      run: () => window.dispatchEvent(new Event(COMMAND_PALETTE_TOGGLE_EVENT)),
    },
    {
      id: "toggle-layouts",
      titleKey: "toggle-layouts",
      icon: LayoutGrid,
      group: "layout",
      run: () => window.dispatchEvent(new Event(LAYOUT_BAR_TOGGLE_EVENT)),
    },
    {
      id: "split-right",
      titleKey: "split-right",
      icon: PanelRight,
      group: "layout",
      run: (ctx) => {
        const s = usePanesStore.getState();
        const target = ctx.paneId ?? s.activePaneId;
        if (target) s.splitRight(target);
      },
    },
    {
      id: "split-down",
      titleKey: "split-down",
      icon: PanelBottom,
      group: "layout",
      run: (ctx) => {
        const s = usePanesStore.getState();
        const target = ctx.paneId ?? s.activePaneId;
        if (target) s.splitDown(target);
      },
    },
    {
      id: "close-pane",
      titleKey: "close-pane",
      icon: XCircle,
      group: "layout",
      run: (ctx) => {
        const s = usePanesStore.getState();
        const target = ctx.paneId ?? s.activePaneId;
        if (target) s.closePane(target);
      },
    },
    {
      id: "equalize-panes",
      titleKey: "equalize-panes",
      icon: Equal,
      group: "layout",
      when: () => usePanesStore.getState().rootPane.type === "split",
      run: () => usePanesStore.getState().equalizePaneSizes(),
    },
    {
      id: "zoom-pane",
      titleKey: "zoom-pane",
      icon: Expand,
      group: "layout",
      when: () => usePanesStore.getState().allPanels().length > 1,
      run: (ctx) => {
        const s = usePanesStore.getState();
        const target = ctx.paneId ?? s.activePaneId;
        if (target) s.togglePaneZoom(target);
      },
    },
    {
      // 分屏并克隆：克隆指定（或激活）终端标签到本窗格，再拆出去——
      // 解决「分屏得到空格还要再点一次启动」的断点。仅终端标签可用。
      id: "split-clone-tab",
      titleKey: "split-clone-tab",
      icon: CopyPlus,
      group: "layout",
      when: (ctx) => resolvePaneTab(ctx)?.tab.contentType === "terminal"
        && Boolean(resolvePaneTab(ctx)?.tab.projectPath),
      run: (ctx) => {
        const resolved = resolvePaneTab(ctx);
        if (!resolved) return;
        const { pane, tab } = resolved;
        if (tab.contentType !== "terminal" || !tab.projectPath) return;
        const s = usePanesStore.getState();
        // 克隆字段与 Panel.handleCloneTab 同口径（全新会话，不共享 PTY）
        s.addTab(pane.id, {
          projectId: tab.projectId,
          projectPath: tab.projectPath,
          workspaceName: tab.workspaceName,
          providerId: tab.providerId,
          modelId: tab.modelId,
          providerSelection: tab.providerSelection,
          launchProfileId: tab.launchProfileId,
          workspacePath: tab.workspacePath,
          workspaceSnapshotId: tab.workspaceSnapshotId,
          cliTool: tab.cliTool ?? (tab.launchClaude ? "claude" : undefined),
          ssh: tab.ssh,
          wsl: tab.wsl,
          machineName: tab.machineName,
        });
        // addTab 把新标签设为激活；splitAndMoveTab 把它拆到目标方向
        const after = s.findPaneById(pane.id);
        const newTabId = after?.type === "panel" ? after.activeTabId : null;
        if (newTabId && newTabId !== tab.id) {
          s.splitAndMoveTab(pane.id, newTabId, ctx.direction ?? "right");
        }
      },
    },
    {
      id: "focus-pane-left",
      titleKey: "focus-pane-left",
      icon: ArrowLeft,
      group: "layout",
      run: () => focusPane("left"),
    },
    {
      id: "focus-pane-right",
      titleKey: "focus-pane-right",
      icon: ArrowRight,
      group: "layout",
      run: () => focusPane("right"),
    },
    {
      id: "focus-pane-up",
      titleKey: "focus-pane-up",
      icon: ArrowUp,
      group: "layout",
      run: () => focusPane("up"),
    },
    {
      id: "focus-pane-down",
      titleKey: "focus-pane-down",
      icon: ArrowDown,
      group: "layout",
      run: () => focusPane("down"),
    },
    {
      id: "next-tab",
      titleKey: "next-tab",
      group: "tab",
      run: () => {
        const s = usePanesStore.getState();
        if (s.activePaneId) s.nextTab(s.activePaneId);
      },
    },
    {
      id: "prev-tab",
      titleKey: "prev-tab",
      group: "tab",
      run: () => {
        const s = usePanesStore.getState();
        if (s.activePaneId) s.prevTab(s.activePaneId);
      },
    },
    // 终端缩放：三个键都**不进** TERMINAL_PASSTHROUGH_ACTIONS——
    // 终端聚焦时恰恰是最需要缩放的时候，放行给终端就等于教了个按不动的键。
    {
      id: "terminal-zoom-in",
      titleKey: "terminal-zoom-in",
      icon: ZoomIn,
      group: "terminal",
      context: "terminal",
      run: () => {
        const store = useSettingsStore.getState();
        const current = store.settings?.terminal.fontSize ?? TERMINAL_FONT_SIZE_DEFAULT;
        store.setTerminalFontSize(current + 1);
      },
    },
    {
      id: "terminal-zoom-out",
      titleKey: "terminal-zoom-out",
      icon: ZoomOut,
      group: "terminal",
      context: "terminal",
      run: () => {
        const store = useSettingsStore.getState();
        const current = store.settings?.terminal.fontSize ?? TERMINAL_FONT_SIZE_DEFAULT;
        store.setTerminalFontSize(current - 1);
      },
    },
    {
      id: "terminal-zoom-reset",
      titleKey: "terminal-zoom-reset",
      icon: RotateCcw,
      group: "terminal",
      context: "terminal",
      run: () =>
        useSettingsStore.getState().setTerminalFontSize(TERMINAL_FONT_SIZE_DEFAULT),
    },
    {
      id: "toggle-mini-mode",
      titleKey: "toggle-mini-mode",
      icon: Minimize2,
      group: "view",
      run: () => useMiniModeStore.getState().toggleMiniMode(),
    },
    {
      id: "voice-input",
      titleKey: "voice-input",
      icon: Mic,
      group: "terminal",
      run: () => requestVoiceInput(),
    },
    {
      id: "show-explorer",
      titleKey: "show-explorer",
      icon: FolderTree,
      group: "view",
      run: () => useActivityBarStore.getState().toggleView("explorer"),
    },
    {
      id: "show-sessions",
      titleKey: "show-sessions",
      icon: MessagesSquare,
      group: "view",
      run: () => useActivityBarStore.getState().toggleView("sessions"),
    },
    {
      id: "show-files",
      titleKey: "show-files",
      icon: FolderOpen,
      group: "view",
      run: () => useActivityBarStore.getState().toggleFilesMode(),
    },
  ];
  // switch-tab-N / switch-layout-N：只从键位触发，不进命令面板；
  // 标题带插值，在这里求值好放进 title。
  for (let i = 1; i <= 9; i++) {
    commands.push({
      id: `switch-tab-${i}`,
      title: i18n.t("switch-tab", { ns: "shortcuts", index: i }),
      group: "tab",
      hiddenFromPalette: true,
      run: () => {
        const s = usePanesStore.getState();
        if (s.activePaneId) s.switchToTab(s.activePaneId, i - 1);
      },
    });
  }
  for (let i = 1; i <= 9; i++) {
    commands.push({
      id: `switch-layout-${i}`,
      title: i18n.t("switch-layout", { ns: "shortcuts", index: i }),
      group: "layout",
      hiddenFromPalette: true,
      run: () => usePanesStore.getState().switchLayoutByIndex(i - 1),
    });
  }
  // 布局预设：与 LayoutPresetPicker 同一份 id/文案（panes 命名空间），
  // 让预设可以从命令面板搜索触发，不再只藏在布局条浮层里。
  const presetLabelKeys: Record<LayoutPresetId, string> = {
    single: "layoutPresetSingle",
    "two-col": "layoutPresetTwoCol",
    "three-col": "layoutPresetThreeCol",
    "two-row": "layoutPresetTwoRow",
    "grid-2x2": "layoutPresetGrid",
    "main-side": "layoutPresetMainSide",
  };
  for (const presetId of Object.keys(presetLabelKeys) as LayoutPresetId[]) {
    commands.push({
      id: `apply-preset-${presetId}`,
      titleKey: presetLabelKeys[presetId],
      titleNs: "panes",
      icon: LayoutGrid,
      group: "layout",
      run: () => usePanesStore.getState().applyLayoutPreset(presetId),
    });
  }
  // 深埋功能命令（截图/本地历史/worktree/Git 时间线/会话清理/速查表）在
  // deepFeatureCommands.ts（行数棘轮约束），与内置命令同一注册通道。
  commands.push(...buildDeepFeatureCommands());
  return commands;
}

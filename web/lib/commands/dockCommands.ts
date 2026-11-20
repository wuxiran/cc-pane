// 右侧面板快捷键：显示/隐藏面板（⌘⌥B / Ctrl+Alt+B）与按竖栏顺序切视图
// （⌘⌥1..9 / Ctrl+Alt+1..9）。编号与竖栏提示同源（dockRailViews），竖栏按模块
// 设置增减时编号跟着变——和 ⌘1..9 切标签同一种心智。
import { PanelRight } from "lucide-react";
import i18n from "@/i18n";
import { useRightDockStore } from "@/stores";
import {
  DOCK_VIEW_SHORTCUT_COUNT,
  TOGGLE_RIGHT_DOCK_COMMAND,
  dockViewCommandId,
  openDockRailViewAt,
} from "@/components/rightdock/dockRailViews";
import type { CommandDescriptor } from "./types";

export function buildDockCommands(): CommandDescriptor[] {
  const commands: CommandDescriptor[] = [
    {
      id: TOGGLE_RIGHT_DOCK_COMMAND,
      titleKey: TOGGLE_RIGHT_DOCK_COMMAND,
      icon: PanelRight,
      group: "view",
      run: () => useRightDockStore.getState().toggleVisible(),
    },
  ];
  for (let index = 0; index < DOCK_VIEW_SHORTCUT_COUNT; index++) {
    commands.push({
      id: dockViewCommandId(index),
      title: i18n.t("focus-dock-view", { ns: "shortcuts", index: index + 1 }),
      group: "view",
      hiddenFromPalette: true,
      run: () => {
        openDockRailViewAt(index);
      },
    });
  }
  return commands;
}

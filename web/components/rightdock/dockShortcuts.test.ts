// 竖栏快捷键：编号与竖栏顺序同源、超范围静默、显示/隐藏命令、默认键位不与既有冲突。
import "@/i18n";
import { beforeEach, describe, expect, it } from "vitest";
import { buildBuiltinCommands } from "@/lib/commands/builtinCommands";
import { createDefaultModulePreferences, useModulePrefsStore } from "@/stores/useModulePrefsStore";
import { useRightDockStore } from "@/stores/useRightDockStore";
import { useSshRemoteFilesStore } from "@/stores/useSshRemoteFilesStore";
import { useSettingsStore } from "@/stores";
import {
  dockViewCommandId,
  openDockRailViewAt,
  resolveDockModules,
  resolveDockRailViews,
} from "./dockRailViews";

function command(id: string) {
  const found = buildBuiltinCommands().find((cmd) => cmd.id === id);
  if (!found) throw new Error(`missing command ${id}`);
  return found;
}

beforeEach(() => {
  localStorage.clear();
  useRightDockStore.setState({ visible: false, activeView: "chat" });
  useModulePrefsStore.setState({ preferences: createDefaultModulePreferences() });
  useSshRemoteFilesStore.getState().clear();
});

describe("dock rail views", () => {
  it("固定顺序：对话 / 文件 / Git，远程文件只在有远程机时出现，会话历史不占格", () => {
    const modules = resolveDockModules(createDefaultModulePreferences());
    const ids = resolveDockRailViews(modules, null).map((view) => view.id);
    expect(ids.slice(0, 3)).toEqual(["chat", "files", "git"]);
    expect(ids).not.toContain("sshFiles");
    expect(ids).not.toContain("sessionHistory");
    expect(resolveDockRailViews(modules, "m-1").map((view) => view.id)[3]).toBe("sshFiles");
  });

  it("按编号切视图并展开面板；超出竖栏数量时不动", () => {
    expect(openDockRailViewAt(2)).toBe(true);
    expect(useRightDockStore.getState()).toMatchObject({ visible: true, activeView: "git" });
    useRightDockStore.setState({ visible: false });
    expect(openDockRailViewAt(8)).toBe(false);
    expect(useRightDockStore.getState().visible).toBe(false);
  });

  it("模块视图走模块自己的 open（编排固定在右侧面板）", () => {
    const views = resolveDockRailViews(resolveDockModules(createDefaultModulePreferences()), null);
    const index = views.findIndex((view) => view.id === "orchestration");
    expect(index).toBeGreaterThan(2);
    openDockRailViewAt(index);
    expect(useRightDockStore.getState()).toMatchObject({ visible: true, activeView: "orchestration" });
  });
});

describe("dock commands", () => {
  it("toggle-right-dock 翻转面板显隐", () => {
    void command("toggle-right-dock").run({});
    expect(useRightDockStore.getState().visible).toBe(true);
    void command("toggle-right-dock").run({});
    expect(useRightDockStore.getState().visible).toBe(false);
  });

  it("focus-dock-view-N 只从键位触发，不进命令面板", () => {
    const cmd = command(dockViewCommandId(1));
    expect(cmd.hiddenFromPalette).toBe(true);
    void cmd.run({});
    expect(useRightDockStore.getState()).toMatchObject({ visible: true, activeView: "files" });
  });

  it("默认键位 ⌘⌥B / ⌘⌥1..9 不与既有默认键位冲突", () => {
    const bindings = useSettingsStore.getState().getDefaults().shortcuts.bindings;
    expect(bindings["toggle-right-dock"]).toBe("Ctrl+Alt+B");
    expect(bindings["focus-dock-view-1"]).toBe("Ctrl+Alt+1");
    expect(bindings["focus-dock-view-9"]).toBe("Ctrl+Alt+9");
    const dockIds = Object.keys(bindings).filter((id) => id === "toggle-right-dock" || id.startsWith("focus-dock-view-"));
    for (const id of dockIds) {
      const clash = Object.entries(bindings).find(([other, combo]) => other !== id && combo === bindings[id]);
      expect(clash, `${id} clashes with ${clash?.[0]}`).toBeUndefined();
    }
  });
});

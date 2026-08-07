import { beforeEach, describe, expect, it } from "vitest";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useRightDockStore } from "@/stores/useRightDockStore";
import { useDialogStore } from "@/stores/useDialogStore";
import { useAiPanelStore } from "@/stores/useAiPanelStore";
import type { TaskBinding } from "@/types";
import {
  MODULE_IDS,
  MODULE_CONSUMERS,
  MODULE_REGISTRY,
  type ModuleBadgeContext,
} from "./registry";

function binding(status: TaskBinding["status"]): TaskBinding {
  return { status } as TaskBinding;
}

function badgeContext(...statuses: TaskBinding["status"][]): ModuleBadgeContext {
  return { bindings: statuses.map(binding) };
}

describe("module registry", () => {
  beforeEach(() => {
    useActivityBarStore.setState({
      activeView: "explorer",
      sidebarVisible: true,
      appViewMode: "home",
      orchestrationOverlayOpen: false,
    });
    useRightDockStore.setState({
      visible: false,
      activeView: "git",
    });
  });

  it("defines the v1 module list once with compatible defaults", () => {
    expect(MODULE_IDS).toEqual([
      "ssh",
      "orchestration",
      "todo",
      "aiPanel",
      "sessionHistory",
    ]);
    expect(MODULE_REGISTRY.map((module) => module.id)).toEqual(MODULE_IDS);
    expect(MODULE_REGISTRY).toHaveLength(5);
    expect(MODULE_REGISTRY.every((module) => module.minimal === false)).toBe(true);
    expect(MODULE_REGISTRY.find((module) => module.id === "aiPanel")?.defaultPosition)
      .toBe("rightDock");
    expect(MODULE_REGISTRY.find((module) => module.id === "orchestration")?.defaultPosition)
      .toBe("rightDock");
  });

  it("declares the presentation shape with orchestration fixed to the right dock", () => {
    expect(MODULE_REGISTRY.map(({ id, surfaces }) => [id, surfaces])).toEqual([
      ["ssh", ["activityBar", "rightDock"]],
      ["orchestration", ["rightDock", "overlay"]],
      ["todo", ["activityBar", "rightDock", "fullscreen"]],
      ["aiPanel", ["rightDock", "dialog"]],
      ["sessionHistory", ["rightDock", "commandPalette", "settings"]],
    ]);
  });

  it("shares one registry instance across every entry consumer", () => {
    expect(Object.keys(MODULE_CONSUMERS)).toEqual([
      "activityBar",
      "contextMenu",
      "rightDock",
      "settings",
      "commandPalette",
    ]);
    expect(Object.values(MODULE_CONSUMERS).every((modules) => modules === MODULE_REGISTRY)).toBe(true);
  });

  it("keeps the orchestration badge source in its module declaration", () => {
    const orchestration = MODULE_REGISTRY.find((module) => module.id === "orchestration");

    expect(orchestration?.badge?.(badgeContext("running", "waiting"))).toEqual({
      tone: "blue",
      value: 2,
    });
    expect(orchestration?.badge?.(badgeContext("running", "failed"))).toEqual({
      tone: "red",
    });
    expect(orchestration?.badge?.(badgeContext("completed"))).toBeUndefined();
  });

  it("declares an amber unread badge for AI panels", () => {
    const aiPanel = MODULE_REGISTRY.find((module) => module.id === "aiPanel");

    expect(aiPanel?.badge?.({ bindings: [], aiPanelUnreadCount: 2 })).toEqual({
      tone: "amber",
      value: 2,
    });
    expect(aiPanel?.badge?.({ bindings: [], aiPanelUnreadCount: 0 })).toBeUndefined();
  });

  it("opens hidden modules through their existing views", () => {
    MODULE_REGISTRY.find((module) => module.id === "orchestration")?.open("hidden");
    expect(useActivityBarStore.getState().orchestrationOverlayOpen).toBe(false);
    expect(useRightDockStore.getState()).toMatchObject({
      visible: true,
      activeView: "orchestration",
    });

    MODULE_REGISTRY.find((module) => module.id === "todo")?.open("hidden");
    expect(useActivityBarStore.getState().appViewMode).toBe("todo");
  });

  it("opens orchestration in the right dock and closes any existing overlay", () => {
    useActivityBarStore.setState({ orchestrationOverlayOpen: true });

    MODULE_REGISTRY.find((module) => module.id === "orchestration")?.open("rightDock");

    expect(useActivityBarStore.getState().orchestrationOverlayOpen).toBe(false);
    expect(useRightDockStore.getState()).toMatchObject({
      visible: true,
      activeView: "orchestration",
    });
  });

  it("opens ssh in its selected host surface", () => {
    const ssh = MODULE_REGISTRY.find((module) => module.id === "ssh");

    ssh?.open("activityBar");
    expect(useActivityBarStore.getState()).toMatchObject({
      activeView: "ssh",
      appViewMode: "panes",
      sidebarVisible: true,
    });

    ssh?.open("rightDock");
    expect(useRightDockStore.getState()).toMatchObject({
      activeView: "ssh",
      visible: true,
    });

    ssh?.open("hidden");
    expect(useActivityBarStore.getState()).toMatchObject({
      activeView: "ssh",
      appViewMode: "panes",
      sidebarVisible: true,
    });
  });

  it("opens AI panels in right dock or dialog surfaces", () => {
    useAiPanelStore.setState({
      panels: [],
      activePanelId: null,
      unreadPanelIds: ["panel-1"],
    });
    useDialogStore.setState({ aiPanelOpen: false });
    const aiPanel = MODULE_REGISTRY.find((module) => module.id === "aiPanel");

    aiPanel?.open("rightDock");
    expect(useRightDockStore.getState()).toMatchObject({ visible: true, activeView: "aiPanel" });

    aiPanel?.open("hidden");
    expect(useDialogStore.getState().aiPanelOpen).toBe(true);
  });

  it("opens session history in the right dock from every entry surface", () => {
    const history = MODULE_REGISTRY.find((module) => module.id === "sessionHistory");

    history?.open("rightDock");
    expect(useRightDockStore.getState()).toMatchObject({
      visible: true,
      activeView: "sessionHistory",
    });

    useRightDockStore.setState({ visible: false, activeView: "git" });
    history?.open("hidden");
    expect(useRightDockStore.getState()).toMatchObject({
      visible: true,
      activeView: "sessionHistory",
    });
  });
});

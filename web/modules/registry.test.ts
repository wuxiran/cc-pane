import { beforeEach, describe, expect, it } from "vitest";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useRightDockStore } from "@/stores/useRightDockStore";
import type { TaskBinding } from "@/types";
import {
  MODULE_IDS,
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
    expect(MODULE_IDS).toEqual(["ssh", "orchestration", "resources", "todo"]);
    expect(MODULE_REGISTRY.map((module) => module.id)).toEqual(MODULE_IDS);
    expect(MODULE_REGISTRY).toHaveLength(4);
    expect(MODULE_REGISTRY.every((module) => (
      module.defaultPosition === "activityBar" && module.minimal === false
    ))).toBe(true);
  });

  it("declares the existing presentation shape without moving module content", () => {
    expect(MODULE_REGISTRY.map(({ id, surfaces }) => [id, surfaces])).toEqual([
      ["ssh", ["activityBar", "rightDock"]],
      ["orchestration", ["activityBar", "rightDock", "overlay"]],
      ["resources", ["activityBar", "rightDock", "fullscreen"]],
      ["todo", ["activityBar", "rightDock", "fullscreen"]],
    ]);
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

  it("opens hidden modules through their existing views", () => {
    MODULE_REGISTRY.find((module) => module.id === "orchestration")?.open("hidden");
    expect(useActivityBarStore.getState().orchestrationOverlayOpen).toBe(true);

    MODULE_REGISTRY.find((module) => module.id === "resources")?.open("hidden");
    expect(useActivityBarStore.getState().appViewMode).toBe("resources");

    MODULE_REGISTRY.find((module) => module.id === "todo")?.open("hidden");
    expect(useActivityBarStore.getState().appViewMode).toBe("todo");
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
  });
});

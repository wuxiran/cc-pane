import { beforeEach, describe, expect, it } from "vitest";
import {
  createModulePreferencesForPreset,
  createDefaultModulePreferences,
  MODULE_PREFS_STORAGE_KEY,
  useModulePrefsStore,
} from "./useModulePrefsStore";

describe("useModulePrefsStore", () => {
  beforeEach(async () => {
    localStorage.clear();
    useModulePrefsStore.setState({
      preferences: createDefaultModulePreferences(),
    });
    await useModulePrefsStore.persist.rehydrate();
  });

  it("defaults modules to their registered enabled positions", () => {
    expect(useModulePrefsStore.getState().preferences).toEqual({
      ssh: { enabled: true, position: "activityBar" },
      orchestration: { enabled: true, position: "activityBar" },
      resources: { enabled: true, position: "activityBar" },
      todo: { enabled: true, position: "activityBar" },
      aiPanel: { enabled: true, position: "rightDock", autoOpen: false, allowAiDialog: true },
      sessionHistory: { enabled: true, position: "rightDock" },
    });
  });

  it("builds full and minimal onboarding snapshots from registry metadata", () => {
    expect(createModulePreferencesForPreset("full")).toEqual(
      createDefaultModulePreferences(),
    );
    expect(createModulePreferencesForPreset("minimal")).toEqual({
      ssh: { enabled: false, position: "activityBar" },
      orchestration: { enabled: false, position: "activityBar" },
      resources: { enabled: false, position: "activityBar" },
      todo: { enabled: false, position: "activityBar" },
      aiPanel: { enabled: false, position: "rightDock", autoOpen: false, allowAiDialog: true },
      sessionHistory: { enabled: false, position: "rightDock" },
    });
  });

  it("applies an onboarding preset as one persisted snapshot", () => {
    useModulePrefsStore.getState().applyPreset("minimal");

    expect(useModulePrefsStore.getState().preferences).toEqual(
      createModulePreferencesForPreset("minimal"),
    );
    expect(JSON.parse(localStorage.getItem(MODULE_PREFS_STORAGE_KEY) ?? "null")).toMatchObject({
      state: {
        preferences: createModulePreferencesForPreset("minimal"),
      },
    });
  });

  it("updates enabled and position independently so hidden does not mean disabled", () => {
    const store = useModulePrefsStore.getState();

    store.setPosition("todo", "hidden");
    expect(useModulePrefsStore.getState().preferences.todo).toEqual({
      enabled: true,
      position: "hidden",
    });

    useModulePrefsStore.getState().setEnabled("todo", false);
    expect(useModulePrefsStore.getState().preferences.todo).toEqual({
      enabled: false,
      position: "hidden",
    });
  });

  it("persists preference changes", () => {
    useModulePrefsStore.getState().setPosition("ssh", "rightDock");

    expect(JSON.parse(localStorage.getItem(MODULE_PREFS_STORAGE_KEY) ?? "null")).toMatchObject({
      state: {
        preferences: {
          ssh: { enabled: true, position: "rightDock" },
        },
      },
    });
  });

  it("fills missing modules and rejects invalid persisted values during upgrades", async () => {
    localStorage.setItem(MODULE_PREFS_STORAGE_KEY, JSON.stringify({
      state: {
        preferences: {
          ssh: { enabled: false, position: "rightDock" },
          todo: { enabled: "yes", position: "somewhere" },
        },
      },
      version: 0,
    }));

    await useModulePrefsStore.persist.rehydrate();

    expect(useModulePrefsStore.getState().preferences).toEqual({
      ssh: { enabled: false, position: "rightDock" },
      orchestration: { enabled: true, position: "activityBar" },
      resources: { enabled: true, position: "activityBar" },
      todo: { enabled: true, position: "activityBar" },
      aiPanel: { enabled: true, position: "rightDock", autoOpen: false, allowAiDialog: true },
      sessionHistory: { enabled: true, position: "rightDock" },
    });
  });

  it("persists the AI panel auto-open preference independently", () => {
    useModulePrefsStore.getState().setAutoOpen("aiPanel", true);

    expect(useModulePrefsStore.getState().preferences.aiPanel).toEqual({
      enabled: true,
      position: "rightDock",
      autoOpen: true,
      allowAiDialog: true,
    });
  });

  it("keeps the AI popup permission on for users persisted before it existed", async () => {
    localStorage.setItem(MODULE_PREFS_STORAGE_KEY, JSON.stringify({
      state: { preferences: { aiPanel: { enabled: true, position: "rightDock", autoOpen: false } } },
      version: 0,
    }));
    await useModulePrefsStore.persist.rehydrate();

    expect(useModulePrefsStore.getState().preferences.aiPanel).toEqual({
      enabled: true,
      position: "rightDock",
      autoOpen: false,
      allowAiDialog: true,
    });
  });
});

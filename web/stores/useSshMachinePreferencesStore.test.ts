import { beforeEach, describe, expect, it } from "vitest";
import {
  SSH_MACHINE_PREFERENCES_STORAGE_KEY,
  useSshMachinePreferencesStore,
} from "./useSshMachinePreferencesStore";

describe("useSshMachinePreferencesStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useSshMachinePreferencesStore.setState({
      favoriteMachineIds: [],
      selectedMachineId: null,
    });
  });

  it("toggles a machine favorite and persists only its id", () => {
    useSshMachinePreferencesStore.getState().toggleFavorite("machine-1");

    expect(useSshMachinePreferencesStore.getState().favoriteMachineIds).toEqual([
      "machine-1",
    ]);
    expect(
      JSON.parse(localStorage.getItem(SSH_MACHINE_PREFERENCES_STORAGE_KEY) ?? "{}"),
    ).toEqual({
      state: { favoriteMachineIds: ["machine-1"], selectedMachineId: null },
      version: 0,
    });

    useSshMachinePreferencesStore.getState().toggleFavorite("machine-1");
    expect(useSshMachinePreferencesStore.getState().favoriteMachineIds).toEqual([]);
  });

  it("selects a machine independently of favorites", () => {
    useSshMachinePreferencesStore.getState().selectMachine("machine-2");
    expect(useSshMachinePreferencesStore.getState().selectedMachineId).toBe("machine-2");
    expect(
      JSON.parse(localStorage.getItem(SSH_MACHINE_PREFERENCES_STORAGE_KEY) ?? "{}"),
    ).toMatchObject({
      state: { selectedMachineId: "machine-2" },
    });
  });
});

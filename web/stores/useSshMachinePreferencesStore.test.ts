import { beforeEach, describe, expect, it } from "vitest";
import {
  SSH_MACHINE_PREFERENCES_STORAGE_KEY,
  useSshMachinePreferencesStore,
} from "./useSshMachinePreferencesStore";

describe("useSshMachinePreferencesStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useSshMachinePreferencesStore.setState({ favoriteMachineIds: [] });
  });

  it("toggles a machine favorite and persists only its id", () => {
    useSshMachinePreferencesStore.getState().toggleFavorite("machine-1");

    expect(useSshMachinePreferencesStore.getState().favoriteMachineIds).toEqual([
      "machine-1",
    ]);
    expect(
      JSON.parse(localStorage.getItem(SSH_MACHINE_PREFERENCES_STORAGE_KEY) ?? "{}"),
    ).toEqual({ state: { favoriteMachineIds: ["machine-1"] }, version: 0 });

    useSshMachinePreferencesStore.getState().toggleFavorite("machine-1");
    expect(useSshMachinePreferencesStore.getState().favoriteMachineIds).toEqual([]);
  });
});

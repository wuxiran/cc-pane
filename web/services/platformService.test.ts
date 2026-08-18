import { afterEach, describe, expect, it } from "vitest";
import { mockTauriInvoke, resetTauriInvoke } from "@/test/utils/mockTauriInvoke";
import { getDisplayServer } from "./platformService";

describe("platformService", () => {
  afterEach(() => resetTauriInvoke());

  it.each(["wayland", "x11"] as const)("returns the %s display server", async (value) => {
    mockTauriInvoke({ get_display_server: value });
    await expect(getDisplayServer()).resolves.toBe(value);
  });

  it("ignores unknown host values", async () => {
    mockTauriInvoke({ get_display_server: "unknown" });
    await expect(getDisplayServer()).resolves.toBeNull();
  });
});

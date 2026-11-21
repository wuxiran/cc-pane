import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/cliInjectionProfileService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/cliInjectionProfileService")>();
  return { ...actual, getCliInjectionProfiles: vi.fn() };
});

import {
  FALLBACK_INJECTION_PROFILES,
  getCliInjectionProfiles,
} from "@/services/cliInjectionProfileService";
import {
  injectionProfileFor,
  loadCliInjectionProfiles,
  resetCliInjectionProfilesForTest,
  useCliInjectionProfilesStore,
} from "./useCliInjectionProfilesStore";

const mocked = vi.mocked(getCliInjectionProfiles);

afterEach(() => {
  resetCliInjectionProfilesForTest();
  mocked.mockReset();
});

describe("useCliInjectionProfilesStore", () => {
  it("未加载时同步读到静态兜底", () => {
    expect(injectionProfileFor("claude")).toEqual(FALLBACK_INJECTION_PROFILES.claude);
    expect(injectionProfileFor("none")).toBeNull();
  });

  it("加载成功后用后端描述覆盖兜底，重复调用只请求一次", async () => {
    const live = { ...FALLBACK_INJECTION_PROFILES, claude: { ...FALLBACK_INJECTION_PROFILES.claude, skills: { mount: "none", promptFallback: false, nativeSources: [] } } };
    mocked.mockResolvedValue(live as never);
    await Promise.all([loadCliInjectionProfiles(), loadCliInjectionProfiles()]);
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(useCliInjectionProfilesStore.getState().loaded).toBe(true);
    expect(injectionProfileFor("claude")?.skills.mount).toBe("none");
  });

  it("加载失败保持兜底", async () => {
    mocked.mockRejectedValue(new Error("old backend"));
    await loadCliInjectionProfiles();
    expect(useCliInjectionProfilesStore.getState().loaded).toBe(false);
    expect(injectionProfileFor("codex")).toEqual(FALLBACK_INJECTION_PROFILES.codex);
  });
});

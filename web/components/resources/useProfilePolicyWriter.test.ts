import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLaunchProfilesStore } from "@/stores/useLaunchProfilesStore";
import type { LaunchProfile, LaunchProfileDraft } from "@/types";
import { useProfilePolicyWriter } from "./useProfilePolicyWriter";

const baseProfile = {
  id: "p1",
  name: "p",
  targetTools: ["claude"],
  mcpPolicy: { mode: "default", enabledServerIds: [], disabledServerIds: [], includeCcpanesMcp: true, includeSharedMcp: true },
  skillPolicy: {
    mode: "core", enabledSkillIds: [], disabledSkillIds: [], profileSkills: [], includeProjectSkills: true,
    includeExternalClaudeSkills: true, includeExternalCodexSkills: true, includeExternalPluginSkills: true, target: "session",
  },
  isDefault: true,
} as unknown as LaunchProfile;

const addDisabled = (name: string) => (draft: LaunchProfileDraft): LaunchProfileDraft => ({
  ...draft,
  mcpPolicy: { ...draft.mcpPolicy, disabledServerIds: [...draft.mcpPolicy.disabledServerIds, name] },
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("useProfilePolicyWriter", () => {
  beforeEach(() => {
    useLaunchProfilesStore.setState({ profiles: [baseProfile] });
  });

  it("shows a click at once, then merges clicks made during a write into one more write", async () => {
    const first = deferred();
    const update = vi.fn(async (id: string, next: LaunchProfileDraft) => {
      if (update.mock.calls.length === 1) await first.promise;
      const profile = { ...baseProfile, id, mcpPolicy: next.mcpPolicy } as LaunchProfile;
      useLaunchProfilesStore.setState({ profiles: [profile] });
      return profile;
    });
    useLaunchProfilesStore.setState({ update });
    const { result } = renderHook(() => useProfilePolicyWriter(vi.fn()));

    act(() => result.current.apply("p1", addDisabled("a")));
    expect(result.current.overlay.p1?.mcpPolicy.disabledServerIds).toEqual(["a"]);

    act(() => {
      result.current.apply("p1", addDisabled("b"));
      result.current.apply("p1", addDisabled("c"));
    });
    expect(result.current.overlay.p1?.mcpPolicy.disabledServerIds).toEqual(["a", "b", "c"]);
    expect(update).toHaveBeenCalledTimes(1);

    await act(async () => { first.resolve(); await first.promise; });
    await waitFor(() => expect(result.current.overlay.p1).toBeUndefined());

    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1][1].mcpPolicy.disabledServerIds).toEqual(["a", "b", "c"]);
  });

  it("rolls back and reports when a write fails, dropping what was queued behind it", async () => {
    const first = deferred();
    const update = vi.fn(() => first.promise.then(() => baseProfile));
    useLaunchProfilesStore.setState({ update });
    const onError = vi.fn();
    const { result } = renderHook(() => useProfilePolicyWriter(onError));

    act(() => {
      result.current.apply("p1", addDisabled("a"));
      result.current.apply("p1", addDisabled("b"));
    });
    await act(async () => { first.reject(new Error("boom")); await first.promise.catch(() => undefined); });
    await waitFor(() => expect(result.current.overlay.p1).toBeUndefined());

    expect(onError).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("ignores a profile that no longer exists", () => {
    const update = vi.fn();
    useLaunchProfilesStore.setState({ update });
    const { result } = renderHook(() => useProfilePolicyWriter(vi.fn()));
    act(() => result.current.apply("gone", addDisabled("a")));
    expect(update).not.toHaveBeenCalled();
    expect(result.current.overlay).toEqual({});
  });
});

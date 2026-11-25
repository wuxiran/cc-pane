import { describe, expect, it } from "vitest";
import type { LaunchProfile, Provider } from "@/types";
import type { ProfilesT } from "./launchProfileHelpers";
import { importedProfileDraft, profilesMissingFragment, supplementedProfileDraft } from "./launchProfileImport";
import { withNativeOverride } from "./NativeOverrideEditor";

const t = ((key: string) => key) as unknown as ProfilesT;

const provider: Provider = {
  id: "relay",
  name: "Relay",
  providerType: "open_ai",
  models: [{ id: "gpt-5.5" }],
  isDefault: false,
} as Provider;

function profile(overrides: Partial<LaunchProfile> = {}): LaunchProfile {
  return {
    id: "p1",
    name: "Relay",
    providerId: "relay",
    targetTools: ["codex"],
    mcpPolicy: { mode: "default", enabledServerIds: [], disabledServerIds: [], includeCcpanesMcp: true, includeSharedMcp: true },
    skillPolicy: {
      mode: "core", enabledSkillIds: [], disabledSkillIds: [], profileSkills: [], includeProjectSkills: true,
      includeWorkspaceSkills: true, includeExternalClaudeSkills: true, includeExternalCodexSkills: true,
      includeExternalPluginSkills: true, target: "session",
    },
    isDefault: false,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  } as LaunchProfile;
}

const hints = { nativeTool: "codex", nativeOverride: "service_tier = \"fast\"\n", yoloMode: true, modelId: "gpt-5.5", droppedKeys: ["projects"] };

describe("importedProfileDraft 带上拆出来的运行配置层", () => {
  it("片段 / YOLO / 模型都进草稿", () => {
    const draft = importedProfileDraft(provider, "desc", t, hints)!;
    expect(draft.nativeOverrides).toEqual({ codex: "service_tier = \"fast\"\n" });
    expect(draft.yoloMode).toBe(true);
    expect(draft.modelId).toBe("gpt-5.5");
  });

  it("中转站里没有的模型不写进草稿，别的 CLI 的片段不带", () => {
    const draft = importedProfileDraft(provider, "desc", t, { ...hints, nativeTool: "claude", modelId: "missing" })!;
    expect(draft.nativeOverrides).toBeUndefined();
    expect(draft.modelId).toBeNull();
  });

  it("没有提示时与原来一样", () => {
    const draft = importedProfileDraft(provider, "desc", t)!;
    expect(draft.yoloMode).toBe(false);
    expect(draft.nativeOverrides).toBeUndefined();
  });
});

describe("补充原生配置只填空的", () => {
  it("只挑出片段为空的运行配置", () => {
    const empty = profile({ id: "empty" });
    const filled = profile({ id: "filled", nativeOverrides: { codex: "service_tier = \"flex\"" } });
    const other = profile({ id: "other", providerId: "else" });
    expect(profilesMissingFragment([empty, filled, other], provider, hints).map((item) => item.id)).toEqual(["empty"]);
    expect(profilesMissingFragment([empty], provider, { ...hints, nativeOverride: "" })).toEqual([]);
  });

  it("补片段时保留运行配置的其余字段，已有片段绝不覆盖", () => {
    const draft = supplementedProfileDraft(profile({ yoloMode: false, modelId: "m" }), hints)!;
    expect(draft.nativeOverrides).toEqual({ codex: hints.nativeOverride });
    expect(draft.yoloMode).toBe(false);
    expect(draft.modelId).toBe("m");
    expect(supplementedProfileDraft(profile({ nativeOverrides: { codex: "x = 1" } }), hints)).toBeNull();
  });
});

describe("withNativeOverride", () => {
  it("清空即删除该键", () => {
    expect(withNativeOverride({ codex: "a = 1", claude: "{}" }, "codex", "")).toEqual({ claude: "{}" });
    expect(withNativeOverride(undefined, "claude", "{}")).toEqual({ claude: "{}" });
  });
});

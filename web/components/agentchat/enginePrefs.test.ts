import { beforeEach, describe, expect, it } from "vitest";
import {
  loadAutoApproveKinds,
  loadEnginePrefs,
  loadPreferredConfigOptions,
  saveAutoApproveKinds,
  saveEngineModels,
  saveEngineModes,
  savePreferredConfigOption,
  savePreferredMode,
  savePreferredModel,
} from "./enginePrefs";

describe("enginePrefs", () => {
  beforeEach(() => localStorage.clear());

  it("模型/模式表回填保留仍存在的偏好，消失则清掉", () => {
    saveEngineModels("claude", [{ modelId: "m1" }, { modelId: "m2" }]);
    savePreferredModel("claude", "m2");
    saveEngineModes("claude", [{ id: "default" }, { id: "plan" }]);
    savePreferredMode("claude", "plan");
    expect(loadEnginePrefs("claude")?.preferredModelId).toBe("m2");
    expect(loadEnginePrefs("claude")?.preferredModeId).toBe("plan");

    saveEngineModels("claude", [{ modelId: "m1" }]);
    saveEngineModes("claude", [{ id: "default" }]);
    expect(loadEnginePrefs("claude")?.preferredModelId).toBeNull();
    expect(loadEnginePrefs("claude")?.preferredModeId).toBeNull();
    // 空表不覆盖既有缓存
    saveEngineModels("claude", []);
    expect(loadEnginePrefs("claude")?.models).toEqual([{ modelId: "m1" }]);
  });

  it("旧版 autoApprove 布尔迁移为 ['*']，保存新集合后旧开关清掉", () => {
    localStorage.setItem(
      "ccpanes.acpEngineModelPrefs",
      JSON.stringify({ codex: { models: [], preferredModelId: null, autoApprove: true } }),
    );
    expect(loadAutoApproveKinds("codex")).toEqual(["*"]);
    expect(loadEnginePrefs("codex")?.autoApproveKinds).toEqual(["*"]);
    saveAutoApproveKinds("codex", ["read"]);
    expect(loadAutoApproveKinds("codex")).toEqual(["read"]);
    expect(loadEnginePrefs("codex")?.autoApprove).toBeUndefined();
    expect(loadAutoApproveKinds("unknown")).toEqual([]);
  });

  it("配置项偏好按 configId 记录，null 表示回到引擎默认", () => {
    expect(loadPreferredConfigOptions("grok")).toEqual({});
    savePreferredConfigOption("grok", "reasoning_effort", "high");
    savePreferredConfigOption("grok", "verbosity", "low");
    expect(loadPreferredConfigOptions("grok")).toEqual({ reasoning_effort: "high", verbosity: "low" });
    savePreferredConfigOption("grok", "verbosity", null);
    expect(loadPreferredConfigOptions("grok")).toEqual({ reasoning_effort: "high" });
  });
});

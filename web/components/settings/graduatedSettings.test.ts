import { describe, expect, it } from "vitest";
import { hydrateGraduatedSetting } from "./graduatedSettings";

describe("graduated setting hydration", () => {
  it("prefers the stable value", () => {
    expect(hydrateGraduatedSetting({
      stableValue: false,
      experimentalValue: true,
      defaultValue: true,
      defaultedForAllUsers: true,
    })).toMatchObject({ value: false, source: "stable", needsPersistence: false });
  });

  it("falls back to the legacy experimental value", () => {
    expect(hydrateGraduatedSetting({
      experimentalValue: false,
      defaultValue: true,
    })).toMatchObject({ value: false, source: "experimental", needsPersistence: true });
  });

  it("uses the default when neither persisted value exists", () => {
    expect(hydrateGraduatedSetting({ defaultValue: true })).toMatchObject({
      value: true,
      source: "default",
      needsPersistence: true,
    });
  });

  it("is idempotent after persisting the normalized value and marker", () => {
    const first = hydrateGraduatedSetting({
      experimentalValue: "legacy",
      defaultValue: "default",
    });
    const second = hydrateGraduatedSetting({
      ...first.persisted,
      experimentalValue: "changed legacy value",
      defaultValue: "changed default",
    });

    expect(first.persisted).toEqual({
      stableValue: "legacy",
      defaultedForAllUsers: true,
    });
    expect(second).toMatchObject({
      value: "legacy",
      source: "stable",
      needsPersistence: false,
    });
  });
});

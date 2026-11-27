import { describe, expect, it } from "vitest";
import type { MagpieCatalog } from "@/types/magpie";
import { MAGPIE_LIVE_MODEL_LIMIT, magpieLiveOptions } from "./magpieLiveOptions";
import { magpieQuotaName, mightUseMagpieGateway } from "./magpieLive";
import type { Provider } from "@/types/provider";

const catalog = (overrides: Partial<MagpieCatalog> = {}): MagpieCatalog => ({
  available: true,
  groups: [{ id: "group/code", label: "Code" }, { id: "group/fast" }],
  models: [{ id: "claude/opus" }, { id: "copilot/opus" }],
  ...overrides,
});

describe("magpieLiveOptions", () => {
  it("returns nothing when Magpie is offline", () => {
    const options = magpieLiveOptions({ ...catalog(), available: false }, []);
    expect(options.groups).toEqual([]);
    expect(options.models).toEqual([]);
    expect(options.ids.size).toBe(0);
    expect(magpieLiveOptions(null, []).ids.size).toBe(0);
  });

  it("drops ids the provider already lists", () => {
    const options = magpieLiveOptions(catalog(), [{ id: "group/code" }, { id: "claude/opus" }]);
    expect(options.groups.map((entry) => entry.id)).toEqual(["group/fast"]);
    expect(options.models.map((entry) => entry.id)).toEqual(["copilot/opus"]);
  });

  it("caps models but keeps the selected one", () => {
    const many = Array.from({ length: MAGPIE_LIVE_MODEL_LIMIT + 5 }, (_, index) => ({ id: `p/m${index}` }));
    const last = `p/m${MAGPIE_LIVE_MODEL_LIMIT + 4}`;
    const options = magpieLiveOptions(catalog({ models: many }), [], last);
    expect(options.models).toHaveLength(MAGPIE_LIVE_MODEL_LIMIT + 1);
    expect(options.models[options.models.length - 1]?.id).toBe(last);
    expect(options.ids.has(`p/m${MAGPIE_LIVE_MODEL_LIMIT + 1}`)).toBe(true);
  });
});

describe("mightUseMagpieGateway", () => {
  const base = { id: "p", name: "P", providerType: "anthropic", isDefault: false } as Provider;
  it("accepts Magpie imports and loopback addresses only", () => {
    expect(mightUseMagpieGateway({ ...base, source: { kind: "magpie" } })).toBe(true);
    expect(mightUseMagpieGateway({ ...base, endpoints: { anthropic: "http://127.0.0.1:3425" } })).toBe(true);
    expect(mightUseMagpieGateway({ ...base, baseUrl: "http://localhost:3425/v1" })).toBe(true);
    expect(mightUseMagpieGateway({ ...base, baseUrl: "https://api.example.com" })).toBe(false);
    expect(mightUseMagpieGateway({ ...base, baseUrl: "not a url" })).toBe(false);
    expect(mightUseMagpieGateway(null)).toBe(false);
  });
});

describe("magpieQuotaName", () => {
  it("prefers alias, then name, then user, then provider", () => {
    const quota = { provider: "claude", name: "", kind: "subscription", windows: [], last: false };
    expect(magpieQuotaName({ ...quota, alias: "Work", name: "a@b"})).toBe("Work");
    expect(magpieQuotaName({ ...quota, name: "a@b" })).toBe("a@b");
    expect(magpieQuotaName({ ...quota, user: "u" })).toBe("u");
    expect(magpieQuotaName(quota)).toBe("claude");
  });
});

import { describe, expect, it } from "vitest";
import type { Provider } from "@/types/provider";
import { formFromProvider } from "../providerFormState";
import { buildProviderPayload } from "./providerPayload";
import { prepareProviderSave } from "./providerSave";

const imported: Provider = {
  id: "p1",
  name: "Imported",
  providerType: "anthropic",
  apiKey: null,
  baseUrl: "https://api.example.com",
  region: null,
  projectId: null,
  awsProfile: null,
  configDir: null,
  models: [],
  isDefault: false,
  source: { kind: "cc_switch", externalId: "ext-1", importedAt: "2026-01-01T00:00:00Z", fingerprint: "fp" },
};

describe("buildProviderPayload", () => {
  it("carries the import source back when editing", () => {
    const form = { ...formFromProvider(imported), name: "Renamed" };
    const payload = buildProviderPayload(form, {
      id: imported.id,
      models: [],
      isDefault: false,
      manageAccounts: false,
      source: imported.source,
    });
    expect(payload.name).toBe("Renamed");
    expect(payload.source).toEqual(imported.source);
  });

  it("omits source when none is given (new / duplicate)", () => {
    const payload = buildProviderPayload(formFromProvider(imported, true), {
      id: "p2",
      models: [],
      isDefault: false,
      manageAccounts: false,
    });
    expect(payload).not.toHaveProperty("source");
  });
});

describe("prepareProviderSave", () => {
  const base = { manageAccounts: false, providers: [imported], newId: () => "new-id" };

  it("keeps id and import source when updating", () => {
    const result = prepareProviderSave({ ...formFromProvider(imported), name: "Renamed" }, { ...base, saveAsUpdate: true, editProvider: imported });
    if (!("provider" in result)) throw new Error("expected a provider");
    expect(result.provider.id).toBe("p1");
    expect(result.provider.source).toEqual(imported.source);
  });

  it("drops the source and mints a new id when duplicating", () => {
    const result = prepareProviderSave(formFromProvider(imported, true), { ...base, saveAsUpdate: false, editProvider: imported });
    if (!("provider" in result)) throw new Error("expected a provider");
    expect(result.provider.id).toBe("new-id");
    expect(result.provider).not.toHaveProperty("source");
  });

  it("reports a missing name", () => {
    const result = prepareProviderSave({ ...formFromProvider(imported), name: " " }, { ...base, saveAsUpdate: true, editProvider: imported });
    expect(result).toEqual({ problem: { key: "settings:nameRequired" } });
  });
});

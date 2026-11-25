import { describe, expect, it } from "vitest";
import type { ProviderModel } from "@/types/provider";
import { providerModelDropdownOptions } from "./providerModelOptions";

const models: ProviderModel[] = [
  { id: "a" },
  { id: "b", hidden: true },
  { id: "c", hidden: false },
  { id: "d", hidden: true },
];

describe("providerModelDropdownOptions", () => {
  it("drops hidden models when nothing hidden is selected", () => {
    expect(providerModelDropdownOptions(models, null).map((m) => m.id)).toEqual(["a", "c"]);
    expect(providerModelDropdownOptions(models, "a").map((m) => m.id)).toEqual(["a", "c"]);
  });

  it("keeps a hidden model that is already selected, in original order", () => {
    expect(providerModelDropdownOptions(models, "b").map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("returns everything when no model is hidden", () => {
    expect(providerModelDropdownOptions([{ id: "x" }, { id: "y" }], undefined)).toHaveLength(2);
  });
});

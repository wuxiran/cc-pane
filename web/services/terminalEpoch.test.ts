import { describe, expect, it } from "vitest";
import { normalizeCheckpointEpoch } from "./terminalEpoch";

describe("checkpoint identities", () => {
  it("preserves real adjacent daemon epochs across JSON round trips", () => {
    for (const value of ["117232978312953918", "117232978312953919", "18446744073709551615"]) {
      expect(normalizeCheckpointEpoch(JSON.parse(JSON.stringify(value)))).toBe(value);
    }
  });
  it("only accepts exact legacy numbers", () => {
    expect(normalizeCheckpointEpoch(7)).toBe("7");
    expect(normalizeCheckpointEpoch(0)).toBe("0");
    for (const value of [Number("117232978312953918"), -1, 1.5, "01", "", " 7", "18446744073709551616", null]) {
      expect(normalizeCheckpointEpoch(value)).toBeNull();
    }
  });
});

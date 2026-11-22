import { describe, expect, it } from "vitest";
import {
  applyPersistedAccountChange,
  envDraftsFrom,
  envNeedsRefill,
  envPayload,
  envProblem,
  newKeyAccountDraft,
} from "./drafts";
import { endpointDraftFromProvider, moveEndpointsToPrimary, primaryEndpointKind } from "./endpoints";

describe("env drafts", () => {
  const stored = () => envDraftsFrom([{ name: "TOKEN", value: "", sensitive: true, storage: "keychain" }])[0];

  it("keeps a stored sensitive value while name and flag are unchanged", () => {
    const entry = stored();
    expect(envNeedsRefill(entry)).toBe(false);
    expect(envProblem([entry])).toBeNull();
    expect(envPayload([entry])).toEqual([{ name: "TOKEN", value: null, sensitive: true, storage: "keychain" }]);
  });

  it("asks for the value again after a rename or un-marking sensitive", () => {
    expect(envNeedsRefill({ ...stored(), name: "TOKEN2" })).toBe(true);
    expect(envNeedsRefill({ ...stored(), sensitive: false })).toBe(true);
    expect(envProblem([{ ...stored(), name: "TOKEN2" }])).toEqual({ problem: "needs_refill", name: "TOKEN2" });
    expect(envNeedsRefill({ ...stored(), name: "TOKEN2", value: "v" })).toBe(false);
  });

  it("does not carry stored sensitive values into a copy", () => {
    const [copy] = envDraftsFrom([{ name: "TOKEN", value: "", sensitive: true, storage: "keychain" }], false);
    expect(copy.storage).toBe("none");
    expect(envProblem([copy])).toEqual({ problem: "value_required", name: "TOKEN" });
  });

  it("rejects invalid and duplicate names", () => {
    const [a] = envDraftsFrom([{ name: "1BAD", value: "x" }]);
    expect(envProblem([a])?.problem).toBe("name_invalid");
    const [b, c] = envDraftsFrom([{ name: "A", value: "1" }, { name: "A", value: "2" }]);
    expect(envProblem([b, c])?.problem).toBe("name_duplicate");
  });
});

describe("persisted account changes", () => {
  it("falls back to the first account when the default one is removed", () => {
    const first = newKeyAccountDraft("a", null);
    const second = newKeyAccountDraft("b", null);
    const state = { accounts: [first, second], defaultAccountId: first.id };
    expect(applyPersistedAccountChange(state, { type: "removed", accountId: first.id })).toEqual({
      accounts: [second],
      defaultAccountId: second.id,
    });
    expect(applyPersistedAccountChange(state, { type: "added", account: first })).toBe(state);
  });
});

describe("endpoints", () => {
  it("picks the primary endpoint like the backend", () => {
    expect(primaryEndpointKind("anthropic")).toBe("anthropic");
    expect(primaryEndpointKind("open_ai")).toBe("responses");
    expect(primaryEndpointKind("open_ai", "chat")).toBe("chat");
    expect(primaryEndpointKind("gemini")).toBe("gemini");
    expect(primaryEndpointKind("grok")).toBe("chat");
  });

  it("splits saved endpoints into the address box and the rest", () => {
    const { primary, others } = endpointDraftFromProvider({
      id: "p", name: "p", providerType: "anthropic", isDefault: false,
      endpoints: { anthropic: "https://a", chat: "https://c" },
    });
    expect(primary).toBe("https://a");
    expect(others).toEqual({ anthropic: "", chat: "https://c", responses: "", gemini: "" });
    expect(endpointDraftFromProvider({ id: "p", name: "p", providerType: "anthropic", isDefault: false, baseUrl: "https://legacy" }).primary)
      .toBe("https://legacy");
  });

  it("swaps values when the primary endpoint moves", () => {
    const others = { anthropic: "", chat: "https://c", responses: "", gemini: "" };
    expect(moveEndpointsToPrimary("anthropic", "chat", others)).toEqual({
      anthropic: "https://c", chat: "", responses: "", gemini: "",
    });
  });
});

import { describe, expect, it } from "vitest";
import { getErrorMessage } from "./index";

describe("getErrorMessage", () => {
  it("reads a structured Tauri error message", () => {
    expect(getErrorMessage({ code: "COMFY_OFFLINE", message: "provider is offline" })).toBe("provider is offline");
  });

  it("reads nested bridge error envelopes", () => {
    expect(getErrorMessage({ error: { message: "schema request failed" } })).toBe("schema request failed");
  });

  it("extracts the message from a serialized backend error", () => {
    expect(getErrorMessage(new Error('{"code":"COMFY_OFFLINE","message":"provider is offline"}'))).toBe("provider is offline");
  });
});

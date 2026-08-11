import { describe, expect, it } from "vitest";
import { getCliInstallHint } from "./terminalCliInstallHint";

describe("terminal CLI install hints", () => {
  it("uses the npm package name for OpenCode", () => {
    const hint =
      "Install OpenCode with: npm install -g opencode-ai --registry=https://registry.npmjs.org";
    expect(getCliInstallHint("opencode")).toBe(hint);
    expect(getCliInstallHint("OpenCode")).toBe(hint);
  });

  it("returns no hint for generic tools", () => {
    expect(getCliInstallHint("claude")).toBeNull();
  });
});

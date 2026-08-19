import { describe, expect, it } from "vitest";
import { getCliInstallHint } from "./terminalCliInstallHint";

describe("terminal CLI install hints", () => {
  it("uses Pi's published npm package and keeps postinstall scripts disabled", () => {
    const hint =
      "Install Pi with: npm install -g --ignore-scripts @earendil-works/pi-coding-agent";
    expect(getCliInstallHint("pi")).toBe(hint);
    expect(getCliInstallHint("Pi")).toBe(hint);
  });

  it("uses the npm package name for OpenCode", () => {
    const hint =
      "Install OpenCode with: npm install -g opencode-ai --registry=https://registry.npmjs.org";
    expect(getCliInstallHint("opencode")).toBe(hint);
    expect(getCliInstallHint("OpenCode")).toBe(hint);
  });

  it("uses the official installer and mentions the Bun runtime requirement", () => {
    const hint =
      "Install Oh My Pi with: irm https://omp.sh/install.ps1 | iex (Bun >= 1.3.14 required)";
    expect(getCliInstallHint("omp")).toBe(hint);
    expect(getCliInstallHint("OMP")).toBe(hint);
  });

  it("returns no hint for generic tools", () => {
    expect(getCliInstallHint("claude")).toBeNull();
  });
});

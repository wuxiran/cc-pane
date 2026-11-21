import { describe, expect, it } from "vitest";
import { FALLBACK_INJECTION_PROFILES } from "@/services/cliInjectionProfileService";
import { cliReceivesMcp, mcpReachByRuntime } from "./mcpReach";

const profile = (id: string) => FALLBACK_INJECTION_PROFILES[id];

describe("mcpReach（docs/110 批 5）", () => {
  it("远程 MCP 按传输方式与请求头过滤，规则与 remoteMcpSupported 一致", () => {
    const sse = { kind: "shared" as const, remote: { transport: "sse", hasHeaders: false } };
    expect(cliReceivesMcp(profile("claude"), sse, "local")).toBe(true);
    expect(cliReceivesMcp(profile("codex"), sse, "local")).toBe(false);
    const withHeaders = { kind: "shared" as const, remote: { transport: "http", hasHeaders: true } };
    expect(cliReceivesMcp(profile("claude"), withHeaders, "local")).toBe(true);
    expect(cliReceivesMcp(profile("claude"), withHeaders, "wsl")).toBe(false);
  });

  it("SSH 一个都收不到；WSL 只有描述里 WSL MCP 不为 none 的 CLI", () => {
    const reach = mcpReachByRuntime(FALLBACK_INJECTION_PROFILES, { kind: "shared", remote: null });
    expect(reach.ssh).toEqual([]);
    expect(reach.wsl).toEqual(expect.arrayContaining(["claude", "codex", "opencode"]));
    expect(reach.wsl).not.toContain("cursor");
    expect(reach.local).toEqual(Object.keys(FALLBACK_INJECTION_PROFILES).sort());
  });

  it("工作空间层的 stdio 条目进不了 WSL", () => {
    expect(cliReceivesMcp(profile("claude"), { kind: "layer", http: false }, "wsl")).toBe(false);
    expect(cliReceivesMcp(profile("claude"), { kind: "layer", http: true }, "wsl")).toBe(true);
    expect(cliReceivesMcp(null, { kind: "ccpanes" }, "local")).toBe(false);
  });
});

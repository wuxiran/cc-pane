import { describe, expect, it } from "vitest";
import { FALLBACK_INJECTION_PROFILES } from "@/services/cliInjectionProfileService";
import {
  hasAnyMcp,
  mcpProfileHints,
  nativeSkillSources,
  remoteMcpSupported,
  supportsSshLaunch,
} from "./cliInjectionRules";

const profile = (id: string) => FALLBACK_INJECTION_PROFILES[id];

describe("cliInjectionRules 镜像 Rust 规则", () => {
  it("远程 MCP：与 injection_profile.rs 的 remote_rule_reads_profile 同一组用例", () => {
    expect(remoteMcpSupported(profile("claude"), "sse", true, "local")).toBe(true);
    expect(remoteMcpSupported(profile("codex"), "http", true, "local")).toBe(true);
    expect(remoteMcpSupported(profile("codex"), "sse", false, "local")).toBe(false);
    expect(remoteMcpSupported(profile("claude"), "http", true, "wsl")).toBe(false);
    expect(remoteMcpSupported(profile("claude"), "http", false, "wsl")).toBe(true);
    expect(remoteMcpSupported(null, "http", false, "local")).toBe(false);
  });

  it("MCP 通道与外部技能来源来自描述", () => {
    expect(hasAnyMcp(profile("claude"))).toBe(true);
    expect(hasAnyMcp(null)).toBe(false);
    expect(nativeSkillSources(profile("claude"))).toEqual(["claude", "plugin"]);
    expect(nativeSkillSources(profile("codex"))).toEqual(["codex"]);
    expect(nativeSkillSources(undefined)).toEqual([]);
  });

  it("SSH 启动读 runtimes.ssh.launch，未知 CLI 按可启动", () => {
    expect(supportsSshLaunch(profile("claude"))).toBe(true);
    expect(supportsSshLaunch(profile("pi"))).toBe(false);
    expect(supportsSshLaunch(null)).toBe(true);
  });

  it("没有 MCP 的 CLI 不给提示", () => {
    expect(mcpProfileHints(null)).toEqual([]);
    expect(mcpProfileHints(profile("claude"))).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { FALLBACK_INJECTION_PROFILES } from "@/services/cliInjectionProfileService";
import type { LaunchProfileMcpPolicy } from "@/types/launch-profile";
import {
  hasAnyMcp,
  hubCanRoute,
  hubDeliverySupported,
  launchProfileIsolatesMcp,
  mcpIsolationGap,
  mcpProfileHints,
  nativeSkillSources,
  remoteMcpSupported,
  supportsSshLaunch,
} from "./cliInjectionRules";

const profile = (id: string) => FALLBACK_INJECTION_PROFILES[id];

describe("cliInjectionRules 镜像 Rust 规则", () => {
  it("hub 投递：与 injection_profile.rs 的 hub_delivery_rule_reads_profile 同一组用例", () => {
    expect(hubDeliverySupported(profile("claude"), "local")).toBe(true);
    expect(hubDeliverySupported(profile("codex"), null)).toBe(true);
    expect(hubDeliverySupported(profile("claude"), "wsl")).toBe(false);
    expect(hubDeliverySupported(profile("codex"), "ssh")).toBe(false);
    for (const other of ["gemini", "opencode", "pi", "jcode", "cursor"]) {
      expect(hubDeliverySupported(profile(other), "local")).toBe(false);
    }
    expect(hubCanRoute(null)).toBe(true);
    expect(hubCanRoute({ transport: "http" })).toBe(true);
    expect(hubCanRoute({ transport: "sse" })).toBe(false);
  });

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

  it("隔离提示：启动档收窄 MCP 时，只对隔离不是 full 的 CLI 提示（docs/110 批 3）", () => {
    const open: LaunchProfileMcpPolicy = {
      mode: "default",
      enabledServerIds: [],
      disabledServerIds: [],
      includeCcpanesMcp: true,
      includeSharedMcp: true,
      delivery: "direct",
    };
    const narrowed = { ...open, disabledServerIds: ["fetch"] };
    expect(launchProfileIsolatesMcp(open)).toBe(false);
    expect(launchProfileIsolatesMcp(narrowed)).toBe(true);
    expect(launchProfileIsolatesMcp({ ...open, mode: "custom" })).toBe(true);
    expect(launchProfileIsolatesMcp(null)).toBe(false);

    for (const cli of ["claude", "codex", "opencode", "gemini"]) {
      expect(mcpIsolationGap(profile(cli), narrowed)).toBeNull();
    }
    expect(mcpIsolationGap(profile("cursor"), narrowed)).toBe("declareOnly");
    expect(mcpIsolationGap(profile("cursor"), open)).toBeNull();
    expect(mcpIsolationGap(null, narrowed)).toBeNull();
  });
});

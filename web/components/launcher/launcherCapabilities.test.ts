// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { CliToolInfo } from "@/types";
import { resolveLaunchOptionSupport } from "./launcherCapabilities";

function tool(id: string, capabilities: Partial<CliToolInfo["capabilities"]> | null): CliToolInfo {
  return {
    id,
    displayName: id,
    executable: id,
    versionArgs: ["--version"],
    installed: true,
    version: null,
    path: null,
    capabilities: capabilities as CliToolInfo["capabilities"],
  };
}

const FULL = {
  supportsProvider: true,
  supportsResume: true,
  supportsMcp: true,
  supportsSystemPrompt: true,
  supportsWorkspace: false,
  supportsProjectHooks: false,
  compatibleProviderTypes: [],
};

describe("resolveLaunchOptionSupport", () => {
  it("按声明置灰：grok 支持 effort/maxTurns 但不支持 verbose", () => {
    const tools = [
      tool("grok", {
        ...FULL,
        supportsEffortOption: true,
        supportsVerboseOption: false,
        supportsMaxTurnsOption: true,
      }),
    ];

    expect(resolveLaunchOptionSupport("grok", tools)).toEqual({
      effort: true,
      verbose: false,
      maxTurns: true,
    });
  });

  it("三键全 false 的 CLI（cursor/gemini/glm/kimi/opencode 实测如此）全部置灰", () => {
    const tools = [
      tool("gemini", {
        ...FULL,
        supportsEffortOption: false,
        supportsVerboseOption: false,
        supportsMaxTurnsOption: false,
      }),
    ];

    expect(resolveLaunchOptionSupport("gemini", tools)).toEqual({
      effort: false,
      verbose: false,
      maxTurns: false,
    });
  });

  /**
   * 这条锁的是一个**反直觉但必须如此**的决策，别"顺手改严格"：
   * 这三个能力位是后加的，旧 daemon / 安装版根本不发。把缺失当"不支持"会在版本错配时
   * 把 claude 的 effort 也置灰——用能力声明去禁用一个实际可用的功能，比不置灰更糟。
   * 同 CLAUDE.md「服务端新增身份/协议字段必须可缺失」：缺失降级可用，存在且 false 才是真信号。
   */
  it("字段缺失按「支持」处理（旧后端不发字段 ≠ 能力缺失）", () => {
    const tools = [tool("claude", FULL)];

    expect(resolveLaunchOptionSupport("claude", tools)).toEqual({
      effort: true,
      verbose: true,
      maxTurns: true,
    });
  });

  it("部分缺失时只对显式 false 的那项置灰", () => {
    const tools = [tool("codex", { ...FULL, supportsEffortOption: true })];

    expect(resolveLaunchOptionSupport("codex", tools)).toEqual({
      effort: true,
      verbose: true,
      maxTurns: true,
    });
  });

  it("CLI 未加载 / 无 capabilities / none 时全开，不要凭空置灰", () => {
    expect(resolveLaunchOptionSupport("claude", [])).toEqual({
      effort: true,
      verbose: true,
      maxTurns: true,
    });
    expect(resolveLaunchOptionSupport("claude", [tool("claude", null)])).toEqual({
      effort: true,
      verbose: true,
      maxTurns: true,
    });
    expect(resolveLaunchOptionSupport("none", [])).toEqual({
      effort: true,
      verbose: true,
      maxTurns: true,
    });
  });
});

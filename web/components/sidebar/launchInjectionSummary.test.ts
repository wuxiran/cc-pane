import { describe, expect, it } from "vitest";
import type { LaunchProfile } from "@/types";
import { defaultLaunchProfileDraft } from "@/types/launch-profile";
import { summarizeInjection } from "./launchInjectionSummary";

const base: LaunchProfile = {
  id: "p",
  createdAt: "",
  updatedAt: "",
  ...defaultLaunchProfileDraft(),
  name: "Default",
  isDefault: true,
};

describe("summarizeInjection", () => {
  it("本机 + 默认策略：三项全注入", () => {
    const s = summarizeInjection(base, "local", "claude");
    expect([s.mcp, s.skills, s.memory]).toEqual(["on", "on", "on"]);
  });

  it("WSL：MCP 只进 HTTP 型（partial），skills 走 /mnt 挂载（on）", () => {
    const s = summarizeInjection(base, "wsl", "codex");
    expect(s.mcp).toBe("partial");
    expect(s.skills).toBe("on");
    expect(s.memory).toBe("on");
    expect(s.reasons.mcp).toBe("injection.mcpWslHttpOnly");
    expect(s.reasons.skills).toBe("injection.skillsWslMounted");
  });

  it("SSH：工作空间层完全不注入", () => {
    const s = summarizeInjection(base, "ssh", "claude");
    expect(s.mcp).toBe("partial");
    expect(s.skills).toBe("off");
    expect(s.reasons.skills).toBe("injection.skillsSshNone");
  });

  it("运行配置关掉 MCP 或 ccpanes：MCP off", () => {
    expect(summarizeInjection({ ...base, mcpPolicy: { ...base.mcpPolicy, mode: "disabled" } }, "local", "claude").mcp).toBe("off");
    expect(summarizeInjection({ ...base, mcpPolicy: { ...base.mcpPolicy, includeCcpanesMcp: false } }, "local", "claude").mcp).toBe("off");
  });

  it("skill 全关：skills off，记忆降为 partial（hook 可能没装）", () => {
    const s = summarizeInjection({ ...base, skillPolicy: { ...base.skillPolicy, mode: "disabled" } }, "local", "claude");
    expect(s.skills).toBe("off");
    expect(s.memory).toBe("partial");
  });

  it("不支持 MCP 的 CLI 直接 off；没有运行配置按系统默认全开", () => {
    expect(summarizeInjection(base, "local", "gemini").mcp).toBe("off");
    expect(summarizeInjection(base, "local", "gemini").reasons.mcp).toBe("injection.mcpUnsupportedCli");
    const s = summarizeInjection(null, "local", "claude");
    expect([s.mcp, s.skills, s.memory]).toEqual(["on", "on", "on"]);
  });

  it("docs/104：pi / omp / jcode 已接入 MCP 注入链，本机默认策略为 on", () => {
    for (const cli of ["pi", "omp", "jcode"] as const) {
      expect(summarizeInjection(base, "local", cli).mcp).toBe("on");
    }
  });
});

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

  it.each<[string, "wsl" | "ssh", string, string, string, string, string]>([
    ["WSL：MCP 只进 HTTP 型（partial），skills 走 /mnt 挂载（on）", "wsl", "codex", "partial", "injection.mcpWslHttpOnly", "on", "injection.skillsWslMounted"],
    ["SSH：工作空间层完全不注入", "ssh", "claude", "off", "injection.mcpSshNone", "off", "injection.skillsSshNone"],
    ["WSL 下不注入 MCP 的 CLI 显示 off（读注入描述，不再一律 partial）", "wsl", "cursor", "off", "injection.mcpWslNone", "off", "injection.skillsWslNone"],
    ["docs/110 批 4：opencode 在 WSL 里 MCP 只进 HTTP 型、技能走提示词", "wsl", "opencode", "partial", "injection.mcpWslHttpOnly", "partial", "injection.skillsWslPrompt"],
  ])("%s", (_name, runtime, cli, mcp, mcpReason, skills, skillsReason) => {
    const s = summarizeInjection(base, runtime, cli);
    expect(s.mcp).toBe(mcp);
    expect(s.reasons.mcp).toBe(mcpReason);
    expect(s.skills).toBe(skills);
    expect(s.reasons.skills).toBe(skillsReason);
  });

  it("WSL codex：记忆照常注入", () => {
    expect(summarizeInjection(base, "wsl", "codex").memory).toBe("on");
  });

  it("运行配置关掉 MCP：off；只关 ccpanes：本机 partial（共享 / 工作空间层照常），WSL off", () => {
    expect(summarizeInjection({ ...base, mcpPolicy: { ...base.mcpPolicy, mode: "disabled" } }, "local", "claude").mcp).toBe("off");
    const noCcpanes = { ...base, mcpPolicy: { ...base.mcpPolicy, includeCcpanesMcp: false } };
    expect(summarizeInjection(noCcpanes, "local", "claude").mcp).toBe("partial");
    expect(summarizeInjection(noCcpanes, "wsl", "claude").mcp).toBe("off");
  });

  it("skill 全关：skills off，记忆降为 partial（hook 可能没装）", () => {
    const s = summarizeInjection({ ...base, skillPolicy: { ...base.skillPolicy, mode: "disabled" } }, "local", "claude");
    expect(s.skills).toBe("off");
    expect(s.memory).toBe("partial");
  });

  it("没有注入描述的 CLI 直接 off；没有运行配置按系统默认全开", () => {
    expect(summarizeInjection(base, "local", "unknown-cli").mcp).toBe("off");
    expect(summarizeInjection(base, "local", "unknown-cli").reasons.mcp).toBe("injection.mcpUnsupportedCli");
    const s = summarizeInjection(null, "local", "claude");
    expect([s.mcp, s.skills, s.memory]).toEqual(["on", "on", "on"]);
  });

  it("docs/104、docs/110 批 2：pi / omp / jcode 与项目文件注入的 CLI 本机默认策略为 on", () => {
    for (const cli of ["pi", "omp", "jcode", "kimi", "antigravity", "gemini", "cursor", "grok"] as const) {
      expect(summarizeInjection(base, "local", cli).mcp).toBe("on");
    }
  });
});

import "@/i18n";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { defaultLaunchProfileDraft } from "@/types/launch-profile";
import type { LaunchProfileDraft } from "@/types";
import type { KnownCliTool } from "@/types/terminal";
import LaunchProfileMcpCard from "./LaunchProfileMcpCard";

function renderCard(activeTool: KnownCliTool, mcpPolicy: Partial<LaunchProfileDraft["mcpPolicy"]>) {
  const base = defaultLaunchProfileDraft();
  const draft: LaunchProfileDraft = { ...base, mcpPolicy: { ...base.mcpPolicy, ...mcpPolicy } };
  render(<LaunchProfileMcpCard draft={draft} setDraft={() => {}} activeTool={activeTool} setMcpMode={() => {}} />);
}

describe("LaunchProfileMcpCard 隔离提示（docs/110 批 3）", () => {
  it("收窄 MCP 时，对挡不住自身配置的 CLI 给出提示", () => {
    renderCard("cursor", { disabledServerIds: ["fetch"] });
    expect(screen.getByTestId("mcp-isolation-gap")).toHaveTextContent(
      String(i18n.t("providers:mcpIsolationGap.declareOnly" as never)),
    );
  });

  it("能真正隔离的 CLI、或没有收窄时不提示", () => {
    renderCard("claude", { mode: "custom" });
    expect(screen.queryByTestId("mcp-isolation-gap")).not.toBeInTheDocument();
  });

  it("没有收窄时不提示", () => {
    renderCard("cursor", {});
    expect(screen.queryByTestId("mcp-isolation-gap")).not.toBeInTheDocument();
  });
});

import "@/i18n";
import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProvidersStore } from "@/stores";
import type { CliToolInfo } from "@/types";
import { resetCliUpdatesCache } from "@/hooks/useCliUpdates";
import HomeAgentList from "./HomeAgentList";

const checkCliUpdates = vi.hoisted(() => vi.fn());
vi.mock("@/services/cliUpdateService", () => ({ checkCliUpdates }));

function tool(id: string, displayName: string, version: string): CliToolInfo {
  return { id, displayName, executable: id, versionArgs: [], installed: true, version, path: `/bin/${id}` };
}

beforeEach(() => {
  resetCliUpdatesCache();
  checkCliUpdates.mockReset();
  useProvidersStore.setState({
    providers: [],
    defaultProviderIds: {},
    systemActive: true,
    loadProviders: vi.fn(async () => undefined),
  });
});

describe("HomeAgentList updates", () => {
  const tools = [tool("claude", "Claude Code", "2.1.330"), tool("codex", "Codex", "codex-cli 0.169.0")];

  it("shows the banner and a per-row update button for outdated agents", async () => {
    checkCliUpdates.mockResolvedValue([
      { id: "claude", currentVersion: null, latestVersion: "2.1.330", source: "npm", package: "@anthropic-ai/claude-code", updateCommand: "npm install -g @anthropic-ai/claude-code@latest" },
      { id: "codex", currentVersion: null, latestVersion: "0.171.0", source: "npm", package: "@openai/codex", updateCommand: "npm install -g @openai/codex@latest" },
    ]);
    render(<HomeAgentList tools={tools} installedTools={tools} loading={false} onRefresh={vi.fn()} onOpenTerminal={vi.fn()} />);

    expect(await screen.findByText("1 个 Agent 有新版本：Codex")).toBeVisible();
    expect(screen.getByRole("button", { name: /全部更新/ })).toBeVisible();
    const [claudeRow, codexRow] = screen.getAllByTestId("home-agent-row");
    expect(within(claudeRow).queryByTestId("home-agent-update")).not.toBeInTheDocument();
    expect(within(codexRow).getByTestId("home-agent-update")).toHaveTextContent("更新到 0.171.0");
  });

  it("does not query updates when it cannot open a terminal", async () => {
    render(<HomeAgentList tools={tools} installedTools={tools} loading={false} onRefresh={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByTestId("home-agent-row")).toHaveLength(2));
    expect(checkCliUpdates).not.toHaveBeenCalled();
    expect(screen.queryByTestId("home-agent-updates")).not.toBeInTheDocument();
  });
});

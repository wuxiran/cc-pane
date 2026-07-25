import "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AgentConciergeEntry from "./AgentConciergeEntry";
import { terminalService } from "@/services";
import {
  useDialogStore,
  useSettingsStore,
  useWorkspacesStore,
} from "@/stores";
import { createTestSettings } from "@/test/utils/testData";
import type { EnvironmentInfo, OpenTerminalOptions, Workspace } from "@/types";

function environment(claude: boolean, codex: boolean): EnvironmentInfo {
  return {
    node: { installed: true, version: "v22" },
    git: { installed: true, version: "2.46" },
    wsl: { installed: false, version: null, applicable: false },
    cliTools: [
      {
        id: "claude",
        displayName: "Claude Code",
        executable: "claude",
        versionArgs: ["--version"],
        installed: claude,
        version: null,
        path: claude ? "/usr/bin/claude" : null,
      },
      {
        id: "codex",
        displayName: "Codex CLI",
        executable: "codex",
        versionArgs: ["--version"],
        installed: codex,
        version: null,
        path: codex ? "/usr/bin/codex" : null,
      },
    ],
    claude: { installed: claude, version: null },
    codex: { installed: codex, version: null },
  };
}

const workspace: Workspace = {
  id: "workspace-1",
  name: "demo",
  createdAt: "2026-07-25T00:00:00Z",
  projects: [{ id: "project-1", path: "/workspace/demo" }],
};

describe("AgentConciergeEntry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const settings = createTestSettings();
    settings.general.defaultCliTool = "claude";
    useSettingsStore.setState({ settings });
    useWorkspacesStore.setState({
      workspaces: [workspace],
      expandedWorkspaceId: workspace.id,
      expandedProjectId: workspace.projects[0].id,
    });
    useDialogStore.setState({ pendingLaunch: null });
  });

  it("launches the selected CLI with MCP and the resource-backed concierge prompt", async () => {
    const user = userEvent.setup();
    const onOpenTerminal = vi.fn<(options: OpenTerminalOptions) => void>();
    render(
      <AgentConciergeEntry
        environment={environment(true, true)}
        onOpenTerminal={onOpenTerminal}
      />,
    );

    await user.click(screen.getByRole("button", { name: "对 agent 说" }));

    expect(onOpenTerminal).toHaveBeenCalledWith(expect.objectContaining({
      path: "/workspace/demo",
      cliTool: "claude",
      skipMcp: false,
      appendSystemPrompt: expect.stringContaining("launch_task"),
    }));
    const prompt = onOpenTerminal.mock.calls[0][0].appendSystemPrompt ?? "";
    expect(prompt).toContain("create_workspace");
    expect(prompt).toContain("老板模式");
  });

  it("uses the global pending-launch channel on Home", async () => {
    const user = userEvent.setup();
    render(<AgentConciergeEntry environment={environment(false, true)} />);

    await user.click(screen.getByRole("button", { name: "对 agent 说" }));

    expect(useDialogStore.getState().pendingLaunch).toMatchObject({
      path: "/workspace/demo",
      cliTool: "codex",
      skipMcp: false,
      appendSystemPrompt: expect.stringContaining("report_to_leader"),
    });
  });

  it("degrades to an expandable repair card when no supported CLI is available", async () => {
    const user = userEvent.setup();
    vi.spyOn(terminalService, "checkEnvironment").mockResolvedValue(environment(false, false));
    render(<AgentConciergeEntry />);

    const repair = await screen.findByRole("button", { name: "修复运行环境" });
    await user.click(repair);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "复制 Claude Code 修复命令" })).toBeVisible();
      expect(screen.getByRole("button", { name: "复制 Codex CLI 修复命令" })).toBeVisible();
    });
    expect(useDialogStore.getState().pendingLaunch).toBeNull();
  });
});

import "@/i18n";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OnboardingGuide from "./OnboardingGuide";
import {
  createDefaultModulePreferences,
  createModulePreferencesForPreset,
  useDialogStore,
  useModulePrefsStore,
  usePanesStore,
  useSettingsStore,
  useWorkspacesStore,
} from "@/stores";
import { terminalService } from "@/services";
import * as workspaceService from "@/services/workspaceService";
import { createTestSettings } from "@/test/utils/testData";
import { mockTauriInvoke } from "@/test/utils/mockTauriInvoke";
import type { EnvironmentInfo, OpenTerminalOptions, Workspace, WorkspaceProject } from "@/types";

function makeEnv(claudeInstalled = true, codexInstalled = true): EnvironmentInfo {
  return {
    node: { installed: true, version: "v22.0.0" },
    git: { installed: true, version: "git version 2.46.0" },
    wsl: { installed: false, version: null, applicable: false },
    cliTools: [
      {
        id: "claude",
        displayName: "Claude Code",
        executable: "claude",
        versionArgs: ["--version"],
        installed: claudeInstalled,
        version: claudeInstalled ? "1.0.0" : null,
        path: claudeInstalled ? "/usr/bin/claude" : null,
      },
      {
        id: "codex",
        displayName: "Codex CLI",
        executable: "codex",
        versionArgs: ["--version"],
        installed: codexInstalled,
        version: codexInstalled ? "1.0.0" : null,
        path: codexInstalled ? "/usr/bin/codex" : null,
      },
    ],
    claude: { installed: claudeInstalled, version: null },
    codex: { installed: codexInstalled, version: null },
  };
}

const workspace: Workspace = {
  id: "workspace-1",
  name: "demo",
  createdAt: "2026-07-25T00:00:00Z",
  projects: [],
};

const project: WorkspaceProject = {
  id: "project-1",
  path: "/workspace/demo",
};

async function goToPresetStep(user: ReturnType<typeof userEvent.setup>) {
  const next = await screen.findByRole("button", { name: "继续选择模式" });
  await waitFor(() => expect(next).toBeEnabled());
  await user.click(next);
}

async function goToParallelStep(user: ReturnType<typeof userEvent.setup>) {
  await goToPresetStep(user);
  await user.click(screen.getByRole("radio", { name: /全功能模式/ }));
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.click(screen.getByRole("button", { name: "跳过此步" }));
}

describe("OnboardingGuide", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockTauriInvoke({ update_settings: null });
    vi.spyOn(terminalService, "checkEnvironment").mockResolvedValue(makeEnv());
    useDialogStore.setState({ onboardingOpen: true });
    useSettingsStore.setState({ settings: createTestSettings() });
    useModulePrefsStore.setState({ preferences: createDefaultModulePreferences() });
    useWorkspacesStore.setState({
      workspaces: [],
      expandedWorkspaceId: null,
      expandedProjectId: null,
    });
  });

  it("renders the five-step preflight with persistent repair actions", async () => {
    vi.mocked(terminalService.checkEnvironment).mockResolvedValue(makeEnv(false, true));
    render(<OnboardingGuide onOpenTerminal={vi.fn()} />);

    expect(await screen.findByText("先确认运行环境")).toBeVisible();
    expect(screen.getByText("第 1 / 5 步")).toBeVisible();
    const copyRegion = within(screen.getByTestId("guided-dialog-copy"));
    expect(copyRegion.getByText("Git")).toBeVisible();
    expect(copyRegion.getByText("WSL")).toBeVisible();
    expect(screen.getByRole("button", { name: "复制 Claude Code 修复命令" })).toBeVisible();
    expect(screen.getByText("也可以直接对 agent 说")).toBeVisible();
  });

  it("supports next, back, per-step skip and applies the minimal preset", async () => {
    const user = userEvent.setup();
    render(<OnboardingGuide onOpenTerminal={vi.fn()} />);

    await goToPresetStep(user);
    expect(screen.getByText("选择你的工作台模式")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "上一步" }));
    expect(screen.getByText("先确认运行环境")).toBeVisible();

    await goToPresetStep(user);
    await user.click(screen.getByRole("radio", { name: /极简模式/ }));
    await user.click(screen.getByRole("button", { name: "继续" }));

    expect(useModulePrefsStore.getState().preferences).toEqual(
      createModulePreferencesForPreset("minimal"),
    );
    expect(screen.getByText("创建第一个工作空间")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "跳过此步" }));
    expect(screen.getByText("并排启动两个会话")).toBeVisible();
  });

  it("scans a directory, creates a workspace and imports discovered projects", async () => {
    const user = userEvent.setup();
    vi.spyOn(workspaceService, "scanDirectory").mockResolvedValue([{
      mainPath: project.path,
      mainBranch: "main",
      worktrees: [],
    }]);
    vi.spyOn(workspaceService, "createWorkspace").mockResolvedValue(workspace);
    vi.spyOn(workspaceService, "addWorkspaceProject").mockResolvedValue(project);
    render(<OnboardingGuide onOpenTerminal={vi.fn()} />);

    await goToPresetStep(user);
    await user.click(screen.getByRole("radio", { name: /全功能模式/ }));
    await user.click(screen.getByRole("button", { name: "继续" }));
    await user.type(screen.getByRole("textbox", { name: "工作空间名称" }), "demo");
    await user.type(screen.getByRole("textbox", { name: "项目目录" }), project.path);
    await user.click(screen.getByRole("button", { name: "扫描目录" }));

    expect(await screen.findByText("发现 1 个项目")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "创建并导入" }));

    await waitFor(() => {
      expect(workspaceService.createWorkspace).toHaveBeenCalledWith("demo", project.path);
      expect(workspaceService.addWorkspaceProject).toHaveBeenCalledWith("demo", project.path);
    });
    expect(await screen.findByText("并排启动两个会话")).toBeVisible();
  });

  it("launches Claude and Codex beside each other for the selected project", async () => {
    const user = userEvent.setup();
    const onOpenTerminal = vi.fn<(options: OpenTerminalOptions) => void>();
    const splitRight = vi.spyOn(usePanesStore.getState(), "splitRight");
    useWorkspacesStore.setState({
      workspaces: [{ ...workspace, projects: [project] }],
      expandedWorkspaceId: workspace.id,
      expandedProjectId: project.id,
    });
    render(<OnboardingGuide onOpenTerminal={onOpenTerminal} />);

    await goToParallelStep(user);
    await user.click(screen.getByRole("button", { name: "一键并排启动" }));

    expect(onOpenTerminal).toHaveBeenCalledTimes(2);
    expect(onOpenTerminal.mock.calls.map(([options]) => options.cliTool)).toEqual([
      "claude",
      "codex",
    ]);
    expect(splitRight).toHaveBeenCalledTimes(1);
    expect(screen.getByText("你的工作台已就绪")).toBeVisible();
  });

  it("opens the concierge from the agent hint with its system prompt injected", async () => {
    const user = userEvent.setup();
    const onOpenTerminal = vi.fn<(options: OpenTerminalOptions) => void>();
    useWorkspacesStore.setState({
      workspaces: [{ ...workspace, projects: [project] }],
      expandedWorkspaceId: workspace.id,
      expandedProjectId: project.id,
    });
    render(<OnboardingGuide onOpenTerminal={onOpenTerminal} />);

    await user.click(await screen.findByRole("button", { name: "对 agent 说" }));

    expect(onOpenTerminal).toHaveBeenCalledWith(expect.objectContaining({
      appendSystemPrompt: expect.stringContaining("老板模式"),
      skipMcp: false,
    }));
  });

  it("skip all persists completion and closes the dialog", async () => {
    const user = userEvent.setup();
    render(<OnboardingGuide onOpenTerminal={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "跳过全部" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "update_settings",
      expect.objectContaining({
        settings: expect.objectContaining({
          general: expect.objectContaining({ onboardingCompleted: true }),
        }),
      }),
    ));
    expect(useDialogStore.getState().onboardingOpen).toBe(false);
  });
});

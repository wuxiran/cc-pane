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

// plugin-dialog 在 jsdom 下不可用：选择文件夹按钮由 isTauriRuntime 门控，测试走手输路径
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

/** 第 1 步（环境与模式）主按钮 = 继续 */
async function leaveEnvironmentStep(user: ReturnType<typeof userEvent.setup>) {
  const next = await screen.findByRole("button", { name: /继续/ });
  await waitFor(() => expect(next).toBeEnabled());
  await user.click(next);
}

async function goToParallelStep(user: ReturnType<typeof userEvent.setup>) {
  await leaveEnvironmentStep(user);
  await user.click(screen.getByRole("button", { name: /继续/ }));
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

  it("renders the environment+mode step in a single column with a three-step nav", async () => {
    vi.mocked(terminalService.checkEnvironment).mockResolvedValue(makeEnv(false, true));
    const user = userEvent.setup();
    render(<OnboardingGuide onOpenTerminal={vi.fn()} />);

    expect(await screen.findByText("检查环境")).toBeVisible();
    expect(screen.queryByTestId("guided-dialog-visual")).toBeNull();
    const copyRegion = within(screen.getByTestId("guided-dialog-copy"));
    expect(copyRegion.getByText("Git")).toBeVisible();
    // WSL 在不适用的平台上不出现
    expect(copyRegion.queryByText("WSL")).toBeNull();
    // 已装的 CLI 以标签列出；未装的折叠，展开后才有复制命令
    expect(copyRegion.getByText("已检测到 1 个 CLI")).toBeVisible();
    expect(copyRegion.getByText("Codex CLI")).toBeVisible();
    expect(screen.queryByRole("button", { name: "复制 Claude Code 修复命令" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "安装其他 CLI（1）" }));
    expect(screen.getByRole("button", { name: "复制 Claude Code 修复命令" })).toBeVisible();

    expect(screen.getByRole("radio", { name: "全功能模式" })).toBeVisible();
    const nav = screen.getByRole("navigation", { name: "引导步骤" });
    expect(within(nav).getAllByRole("button")).toHaveLength(3);
    expect(within(nav).getByText("环境")).toBeVisible();
    expect(within(nav).getByText("项目")).toBeVisible();
    expect(within(nav).getByText("开始")).toBeVisible();
    expect(screen.getByText("也可以直接对 agent 说")).toBeVisible();
    expect(screen.queryByRole("button", { name: "跳过此步" })).toBeNull();
  });

  it("promotes Claude Code and Codex install commands when no CLI is installed", async () => {
    vi.mocked(terminalService.checkEnvironment).mockResolvedValue(makeEnv(false, false));
    render(<OnboardingGuide onOpenTerminal={vi.fn()} />);

    expect(await screen.findByText("还没有可用的 CLI，先装一个：")).toBeVisible();
    expect(screen.getByRole("button", { name: "复制 Claude Code 修复命令" })).toBeVisible();
    expect(screen.getByRole("button", { name: "复制 Codex CLI 修复命令" })).toBeVisible();
  });

  it("applies the selected preset when leaving step one and allows nav back", async () => {
    const user = userEvent.setup();
    render(<OnboardingGuide onOpenTerminal={vi.fn()} />);

    await screen.findByText("检查环境");
    await user.click(screen.getByRole("radio", { name: "极简模式" }));
    expect(screen.getByText(/保留终端、项目、编辑器与启动器/)).toBeVisible();
    await leaveEnvironmentStep(user);

    expect(useModulePrefsStore.getState().preferences).toEqual(
      createModulePreferencesForPreset("minimal"),
    );
    expect(screen.getByText("导入项目")).toBeVisible();

    const nav = screen.getByRole("navigation", { name: "引导步骤" });
    await user.click(within(nav).getByRole("button", { name: /环境/ }));
    expect(screen.getByText("检查环境")).toBeVisible();
    expect(within(nav).getByRole("button", { name: /开始/ })).toBeDisabled();
  });

  it("imports a folder in one click, naming the workspace after the folder", async () => {
    const user = userEvent.setup();
    vi.spyOn(workspaceService, "scanDirectory").mockResolvedValue([{
      mainPath: project.path,
      mainBranch: "main",
      worktrees: [],
    }]);
    const createSpy = vi.spyOn(workspaceService, "createWorkspace").mockResolvedValue(workspace);
    vi.spyOn(workspaceService, "addWorkspaceProject").mockResolvedValue(project);
    render(<OnboardingGuide onOpenTerminal={vi.fn()} />);

    await leaveEnvironmentStep(user);
    const footer = within(screen.getByTestId("guided-dialog-footer"));
    expect(footer.getByRole("button", { name: /导入/ })).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "项目目录" }), "/workspace/demo/");
    expect(screen.getByRole("textbox", { name: "工作空间名称" })).toHaveAttribute("placeholder", "demo");
    await user.click(footer.getByRole("button", { name: /导入/ }));

    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    expect(createSpy.mock.calls[0][0]).toBe("demo");
    expect(await screen.findByText("并排启动两个 agent")).toBeVisible();
  });

  it("reports an empty folder without leaving the project step", async () => {
    const user = userEvent.setup();
    vi.spyOn(workspaceService, "scanDirectory").mockResolvedValue([]);
    const createSpy = vi.spyOn(workspaceService, "createWorkspace");
    render(<OnboardingGuide onOpenTerminal={vi.fn()} />);

    await leaveEnvironmentStep(user);
    await user.type(screen.getByRole("textbox", { name: "项目目录" }), "/empty");
    await user.click(within(screen.getByTestId("guided-dialog-footer")).getByRole("button", { name: /导入/ }));

    expect(await screen.findByText("该目录下没有发现可导入的 Git 项目。")).toBeVisible();
    expect(createSpy).not.toHaveBeenCalled();
    expect(screen.getByText("导入项目")).toBeVisible();
  });

  it("confirms an existing project and can switch to importing another folder", async () => {
    const user = userEvent.setup();
    useWorkspacesStore.setState({
      workspaces: [{ ...workspace, projects: [project] }],
      expandedWorkspaceId: workspace.id,
      expandedProjectId: project.id,
    });
    render(<OnboardingGuide onOpenTerminal={vi.fn()} />);

    await leaveEnvironmentStep(user);
    expect(screen.getByText("/workspace/demo", { exact: false })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "项目目录" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "导入其他目录…" }));
    expect(screen.getByRole("textbox", { name: "项目目录" })).toBeVisible();
  });

  it("launches Claude and Codex beside each other, then finishes the guide", async () => {
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
    expect(screen.getByText(/设置 → 上手清单/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "并排启动" }));

    expect(onOpenTerminal).toHaveBeenCalledTimes(2);
    expect(onOpenTerminal.mock.calls.map(([options]) => options.cliTool)).toEqual([
      "claude",
      "codex",
    ]);
    expect(splitRight).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("cc-panes-onboarding-multi-launch")).toBe("true");
    // 退让动画（或 reduced-motion 直达）后引导完成并关闭
    await waitFor(
      () => expect(useDialogStore.getState().onboardingOpen).toBe(false),
      { timeout: 4000 },
    );
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

  it("skip guide persists completion and closes the dialog", async () => {
    const user = userEvent.setup();
    render(<OnboardingGuide onOpenTerminal={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "跳过引导" }));

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

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

/** 第 1 步（环境与模式）主按钮 = 继续 */
async function leaveEnvironmentStep(user: ReturnType<typeof userEvent.setup>) {
  const next = await screen.findByRole("button", { name: "继续" });
  await waitFor(() => expect(next).toBeEnabled());
  await user.click(next);
}

async function goToParallelStep(user: ReturnType<typeof userEvent.setup>) {
  await leaveEnvironmentStep(user);
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

  it("renders the merged environment+mode step with step navigation", async () => {
    vi.mocked(terminalService.checkEnvironment).mockResolvedValue(makeEnv(false, true));
    render(<OnboardingGuide onOpenTerminal={vi.fn()} />);

    expect(await screen.findByText("先确认环境，选好工作台模式")).toBeVisible();
    const copyRegion = within(screen.getByTestId("guided-dialog-copy"));
    expect(copyRegion.getByText("Git")).toBeVisible();
    expect(copyRegion.getByText("WSL")).toBeVisible();
    expect(screen.getByRole("button", { name: "复制 Claude Code 修复命令" })).toBeVisible();
    // 模式双选并入本步
    expect(screen.getByRole("radio", { name: /全功能模式/ })).toBeVisible();
    // 四步导航列出全程
    const nav = screen.getByRole("navigation", { name: "引导步骤" });
    expect(within(nav).getByText("环境与模式")).toBeVisible();
    expect(within(nav).getByText("建工作空间")).toBeVisible();
    expect(within(nav).getByText("并排启动")).toBeVisible();
    expect(within(nav).getByText("就绪")).toBeVisible();
    expect(screen.getByText("也可以直接对 agent 说")).toBeVisible();
  });

  it("applies the selected preset when leaving step one and allows nav back", async () => {
    const user = userEvent.setup();
    render(<OnboardingGuide onOpenTerminal={vi.fn()} />);

    await screen.findByText("先确认环境，选好工作台模式");
    await user.click(screen.getByRole("radio", { name: /极简模式/ }));
    await leaveEnvironmentStep(user);

    expect(useModulePrefsStore.getState().preferences).toEqual(
      createModulePreferencesForPreset("minimal"),
    );
    expect(screen.getByText("创建第一个工作空间")).toBeVisible();

    // 步骤导航可回退到已到过的步
    const nav = screen.getByRole("navigation", { name: "引导步骤" });
    await user.click(within(nav).getByRole("button", { name: /环境与模式/ }));
    expect(screen.getByText("先确认环境，选好工作台模式")).toBeVisible();
    // 未到过的步不可点
    expect(within(nav).getByRole("button", { name: /就绪/ })).toBeDisabled();
  });

  it("drives the workspace step through scan then create-and-import on the primary button", async () => {
    const user = userEvent.setup();
    vi.spyOn(workspaceService, "scanDirectory").mockResolvedValue([{
      mainPath: project.path,
      mainBranch: "main",
      worktrees: [],
    }]);
    vi.spyOn(workspaceService, "createWorkspace").mockResolvedValue(workspace);
    vi.spyOn(workspaceService, "addWorkspaceProject").mockResolvedValue(project);
    render(<OnboardingGuide onOpenTerminal={vi.fn()} />);

    await leaveEnvironmentStep(user);
    await user.type(screen.getByRole("textbox", { name: "工作空间名称" }), "demo");
    await user.type(screen.getByRole("textbox", { name: "项目目录" }), project.path);
    // 无导入项目时主按钮 = 扫描目录（footer 内，与输入区的扫描按钮同功能）
    const footer = within(screen.getByTestId("guided-dialog-footer"));
    await user.click(footer.getByRole("button", { name: "扫描目录" }));

    expect(await screen.findByText("发现 1 个项目")).toBeVisible();
    // 有扫描结果后主按钮变为创建并导入
    await user.click(footer.getByRole("button", { name: "创建并导入" }));

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
    expect(localStorage.getItem("cc-panes-onboarding-multi-launch")).toBe("true");
    // jsdom 的 matchMedia mock 报 reduced-motion=false 时走 2.6s 退让；
    // 无论哪条路径，最终都要进就绪步
    await waitFor(
      () => expect(screen.getByText("你的工作台已就绪")).toBeVisible(),
      { timeout: 4000 },
    );
    expect(screen.getByText(/设置 → 上手清单/)).toBeVisible();
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

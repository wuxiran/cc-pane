import "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OrchestratorInput from "./OrchestratorInput";
import {
  useOrchestratorStore,
  useSettingsStore,
  useWorkspacesStore,
} from "@/stores";
import {
  createTestSettings,
  createTestWorkspace,
  createTestWorkspaceProject,
  resetTestDataCounter,
} from "@/test/utils/testData";

const createMock = vi.fn(async (..._args: unknown[]) => ({ id: "binding-1" }));
const getCurrentBranch = vi.fn(async (..._args: unknown[]) => "main");

vi.mock("@/services", () => ({
  localHistoryService: {
    getCurrentBranch: (...args: unknown[]) => getCurrentBranch(...args),
  },
}));

function seedWorkspaces() {
  useWorkspacesStore.setState({
    workspaces: [
      createTestWorkspace({
        name: "ws-one",
        alias: "One",
        projects: [
          createTestWorkspaceProject({ alias: "frontend", path: "/repo/frontend" }),
          createTestWorkspaceProject({ alias: "backend", path: "/repo/backend" }),
        ],
      }),
    ],
    expandedWorkspaceId: null,
    expandedProjectId: null,
  });
}

describe("OrchestratorInput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTestDataCounter();
    getCurrentBranch.mockResolvedValue("main");
    useSettingsStore.setState({ settings: createTestSettings(), loading: false });
    useOrchestratorStore.setState({
      lastTargetProjectPath: null,
      create: createMock as never,
    });
    seedWorkspaces();
  });

  const getSendButton = () => screen.getByRole("button", { name: /Send|发送/i });

  it("renders the target label with the first project and default CLI", () => {
    render(<OrchestratorInput />);

    // First project of first workspace becomes the default target.
    expect(screen.getByText(/frontend/)).toBeVisible();
    // Default CLI from settings is claude.
    expect(screen.getByText(/🤖 claude/)).toBeVisible();
  });

  it("shows codex as CLI when default cli tool is codex", () => {
    useSettingsStore.setState({
      settings: createTestSettings({
        general: { ...createTestSettings().general, defaultCliTool: "codex" },
      }),
      loading: false,
    });
    render(<OrchestratorInput />);

    expect(screen.getByText(/🤖 codex/)).toBeVisible();
  });

  it("disables the send button when input is empty", () => {
    render(<OrchestratorInput />);

    expect(getSendButton()).toBeDisabled();
  });

  it("enables send after typing and creates a task on click", async () => {
    const user = userEvent.setup();
    render(<OrchestratorInput />);

    const textarea = screen.getByPlaceholderText(/Enter task|输入任务/i);
    await user.type(textarea, "Build feature X");

    const sendBtn = getSendButton();
    expect(sendBtn).toBeEnabled();

    await user.click(sendBtn);

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    const arg = createMock.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).toEqual(
      expect.objectContaining({
        title: "Build feature X",
        prompt: "Build feature X",
        projectPath: "/repo/frontend",
        workspaceName: "ws-one",
        cliTool: "claude",
      }),
    );
  });

  it("clears the textarea after a successful submit", async () => {
    const user = userEvent.setup();
    render(<OrchestratorInput />);

    const textarea = screen.getByPlaceholderText(/Enter task|输入任务/i) as HTMLTextAreaElement;
    await user.type(textarea, "hello");
    await user.click(getSendButton());

    await waitFor(() => expect(textarea.value).toBe(""));
  });

  it("submits on Enter and preserves newline on Shift+Enter", async () => {
    const user = userEvent.setup();
    render(<OrchestratorInput />);

    const textarea = screen.getByPlaceholderText(/Enter task|输入任务/i);
    await user.type(textarea, "line1{Shift>}{Enter}{/Shift}line2");
    // Shift+Enter should not submit.
    expect(createMock).not.toHaveBeenCalled();

    await user.type(textarea, "{Enter}");
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
  });

  it("truncates very long titles to 80 chars plus ellipsis", async () => {
    const user = userEvent.setup();
    render(<OrchestratorInput />);

    const longText = "x".repeat(120);
    await user.type(screen.getByPlaceholderText(/Enter task|输入任务/i), longText);
    await user.click(getSendButton());

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    const arg = createMock.mock.calls[0][0] as { title: string; prompt: string };
    expect(arg.title).toBe("x".repeat(80) + "...");
    expect(arg.prompt).toBe(longText);
  });

  it("still creates the task when reading the git branch fails", async () => {
    getCurrentBranch.mockRejectedValueOnce(new Error("no git"));
    const user = userEvent.setup();
    render(<OrchestratorInput />);

    await user.type(screen.getByPlaceholderText(/Enter task|输入任务/i), "task");
    await user.click(getSendButton());

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    const arg = createMock.mock.calls[0][0] as { metadata: { ui: { gitBranch?: string } } };
    expect(arg.metadata.ui.gitBranch).toBeUndefined();
  });

  it("disables the target selector when there are no workspaces", () => {
    useWorkspacesStore.setState({ workspaces: [] });
    render(<OrchestratorInput />);

    expect(screen.getByText(/No project|无项目/i)).toBeVisible();
    // Send is disabled with no target project.
    expect(getSendButton()).toBeDisabled();
  });

  it("selecting a different project in the popover updates the target", async () => {
    const user = userEvent.setup();
    render(<OrchestratorInput />);

    // Open the target popover via the project/cli chip button.
    await user.click(screen.getByRole("button", { name: /frontend/ }));
    await user.click(await screen.findByRole("button", { name: /backend/ }));

    await waitFor(() =>
      expect(useOrchestratorStore.getState().lastTargetProjectPath).toBe("/repo/backend"),
    );
  });
});

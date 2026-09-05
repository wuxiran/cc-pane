import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import HomeAgentPrompt from "./HomeAgentPrompt";
import { TooltipProvider } from "@/components/ui/tooltip";
import { takePendingStart } from "@/components/agentchat/pendingStart";
import { CONCIERGE_SYSTEM_PROMPT } from "@/components/onboarding/AgentConciergeEntry";
import { agentChatService } from "@/services/agentChatService";
import { usePanesStore, useWorkspacesStore } from "@/stores";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import type { Workspace } from "@/types";

vi.mock("@/services/agentChatService", () => ({
  agentChatService: {
    listEngines: vi.fn(),
  },
}));

// StartProjectMenu 依赖 Tauri 目录对话框；本测试只走注册项目路径。
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

function renderPrompt() {
  return render(
    <TooltipProvider>
      <HomeAgentPrompt />
    </TooltipProvider>,
  );
}

const workspace: Workspace = {
  id: "workspace-1",
  name: "demo",
  createdAt: "2026-07-25T00:00:00Z",
  projects: [{ id: "project-1", path: "/workspace/demo" }],
};

describe("HomeAgentPrompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(agentChatService.listEngines).mockResolvedValue([
      { id: "codex", label: "Codex", available: false, requirement: "codex" },
      { id: "claude", label: "Claude Code", available: true, requirement: "claude" },
    ]);
    useWorkspacesStore.setState({
      workspaces: [workspace],
      expandedWorkspaceId: workspace.id,
      expandedProjectId: workspace.projects[0].id,
    });
    useActivityBarStore.setState({ appViewMode: "home", sidebarVisible: false });
  });

  it("默认选中当前展开的项目与首个可用引擎", async () => {
    renderPrompt();

    expect(screen.getByText("demo")).toBeVisible();
    expect(await screen.findByText("Claude Code")).toBeVisible();
  });

  it("回车后开 agent-chat 标签、挂上管家启动意图并切到工作区", async () => {
    const openAgentChat = vi.fn(() => "tab-1");
    usePanesStore.setState({ openAgentChat });
    renderPrompt();
    await screen.findByText("Claude Code");

    const input = screen.getByRole("textbox", { name: "对 agent 说" });
    fireEvent.change(input, { target: { value: "帮我把测试跑起来" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(openAgentChat).toHaveBeenCalledWith("/workspace/demo"));
    expect(takePendingStart("tab-1")).toEqual({
      engineId: "claude",
      cwd: "/workspace/demo",
      firstPrompt: "帮我把测试跑起来",
      preamble: CONCIERGE_SYSTEM_PROMPT,
    });
    expect(useActivityBarStore.getState().appViewMode).toBe("panes");
    expect(input).toHaveValue("");
  });

  it("没有目标项目时禁用发送并提示先选目录", async () => {
    useWorkspacesStore.setState({ workspaces: [], expandedWorkspaceId: null, expandedProjectId: null });
    renderPrompt();
    await screen.findByText("Claude Code");

    const input = screen.getByRole("textbox", { name: "对 agent 说" });
    expect(input).toHaveAttribute("placeholder", "先选择一个项目或目录，再告诉 agent 你想做什么");
    fireEvent.change(input, { target: { value: "随便做点什么" } });
    expect(screen.getByTestId("home-agent-prompt-send")).toBeDisabled();
  });

  it("没有可用引擎时禁用发送", async () => {
    vi.mocked(agentChatService.listEngines).mockResolvedValue([]);
    renderPrompt();

    expect(await screen.findByText("未检测到可用的 agent 引擎")).toBeVisible();
    const input = screen.getByRole("textbox", { name: "对 agent 说" });
    fireEvent.change(input, { target: { value: "随便做点什么" } });
    expect(screen.getByTestId("home-agent-prompt-send")).toBeDisabled();
  });
});

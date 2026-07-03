import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab, Workspace } from "@/types";
import MobilePrototype from "./MobilePrototype";

// 真实终端组件依赖 xterm/PTY，桩掉
vi.mock("@/components/panes/TerminalTabContent", () => ({
  default: ({ tab }: { tab: Tab }) => (
    <div data-testid="terminal-content">{tab.title}</div>
  ),
}));

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws-1",
    name: "main-ws",
    createdAt: "2026-01-01T00:00:00Z",
    path: "D:/ws",
    projects: [
      { id: "p-1", path: "D:/ws/app", alias: undefined } as Workspace["projects"][number],
      { id: "p-2", path: "D:/ws/lib" } as Workspace["projects"][number],
    ],
    ...overrides,
  };
}

function terminalTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: "tab-1",
    title: "app (Claude)",
    contentType: "terminal",
    projectPath: "D:/ws/app",
    sessionId: "sess-1",
    ...overrides,
  } as Tab;
}

function makeTerminalState(overrides: Record<string, unknown> = {}) {
  return {
    paneId: "pane-1",
    tab: terminalTab(),
    onSessionCreated: vi.fn(),
    onSessionExited: vi.fn(),
    onTerminalRef: vi.fn(),
    onReconnect: vi.fn(),
    onWrite: vi.fn().mockResolvedValue(undefined),
    onSubmit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("MobilePrototype", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows workspace/project metrics in the header", () => {
    render(<MobilePrototype workspaces={[makeWorkspace()]} />);
    const metrics = screen.getByText("工作空间", { selector: "div" }).parentElement!
      .parentElement as HTMLElement;
    expect(metrics.textContent).toContain("1"); // 工作空间数
    expect(metrics.textContent).toContain("2"); // 项目数
  });

  it("requests workspaces on mount", () => {
    const onLoadWorkspaces = vi.fn();
    render(<MobilePrototype workspaces={[]} onLoadWorkspaces={onLoadWorkspaces} />);
    expect(onLoadWorkspaces).toHaveBeenCalled();
  });

  it("shows the empty hint when no workspaces are returned", () => {
    render(<MobilePrototype workspaces={[]} />);
    expect(screen.getByText("当前后端没有返回工作空间")).toBeInTheDocument();
  });

  it("opens a project and switches to the terminal view", async () => {
    const user = userEvent.setup();
    const onOpenProject = vi.fn();
    const ws = makeWorkspace();
    render(<MobilePrototype workspaces={[ws]} onOpenProject={onOpenProject} />);

    await user.click(screen.getByText("lib"));
    expect(onOpenProject).toHaveBeenCalledWith(ws, ws.projects[1]);
    // 终端视图隐藏 header，显示空终端提示
    expect(screen.getByText("还没有打开真实终端")).toBeInTheDocument();
    expect(screen.getByText(/当前选择：main-ws \/ lib/)).toBeInTheDocument();
  });

  it("navigates between views from the bottom nav", async () => {
    const user = userEvent.setup();
    render(<MobilePrototype workspaces={[makeWorkspace()]} />);

    const nav = screen.getByRole("navigation");
    const [, layoutsBtn, terminalBtn] = Array.from(nav.querySelectorAll("button"));

    await user.click(layoutsBtn);
    expect(screen.getByText("暂无可同步布局")).toBeInTheDocument();

    await user.click(terminalBtn);
    expect(screen.getByText("还没有打开真实终端")).toBeInTheDocument();
  });

  describe("workspace action sheet", () => {
    async function openSheet(ws: Workspace, handlers: Record<string, unknown> = {}) {
      const user = userEvent.setup();
      render(<MobilePrototype workspaces={[ws]} {...handlers} />);
      await user.click(screen.getByLabelText("工作空间操作菜单"));
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      return user;
    }

    it("toggles pinned and closes the sheet", async () => {
      const onToggleWorkspacePinned = vi.fn().mockResolvedValue(undefined);
      const ws = makeWorkspace();
      const user = await openSheet(ws, { onToggleWorkspacePinned });

      await user.click(screen.getByText("显示在常用"));
      expect(onToggleWorkspacePinned).toHaveBeenCalledWith(ws);
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
    });

    it("shows the unpin label for pinned workspaces", async () => {
      await openSheet(makeWorkspace({ pinned: true }), {
        onToggleWorkspacePinned: vi.fn(),
      });
      expect(screen.getByText("取消置顶")).toBeInTheDocument();
    });

    it("keeps the sheet open and shows the error when an action fails", async () => {
      const onToggleWorkspacePinned = vi
        .fn()
        .mockRejectedValue(new Error("backend down"));
      const user = await openSheet(makeWorkspace(), { onToggleWorkspacePinned });

      await user.click(screen.getByText("显示在常用"));
      expect(await screen.findByText("backend down")).toBeInTheDocument();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("deletes only after window.confirm approval", async () => {
      const onDeleteWorkspace = vi.fn().mockResolvedValue(undefined);
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
      const user = await openSheet(makeWorkspace(), { onDeleteWorkspace });

      await user.click(screen.getByText("删除工作空间"));
      expect(onDeleteWorkspace).not.toHaveBeenCalled();

      confirmSpy.mockReturnValue(true);
      await user.click(screen.getByText("删除工作空间"));
      expect(onDeleteWorkspace).toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it("sets the alias via prompt, mapping blank input to null", async () => {
      const onSetWorkspaceAlias = vi.fn().mockResolvedValue(undefined);
      const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("   ");
      const ws = makeWorkspace({ alias: "old" });
      const user = await openSheet(ws, { onSetWorkspaceAlias });

      await user.click(screen.getByText("设置别名"));
      expect(promptSpy).toHaveBeenCalledWith("设置别名", "old");
      await waitFor(() => {
        expect(onSetWorkspaceAlias).toHaveBeenCalledWith(ws, null);
      });
      promptSpy.mockRestore();
    });

    it("ignores rename when the prompt is cancelled", async () => {
      const onRenameWorkspace = vi.fn();
      const promptSpy = vi.spyOn(window, "prompt").mockReturnValue(null);
      const user = await openSheet(makeWorkspace(), { onRenameWorkspace });

      await user.click(screen.getByText("重命名"));
      expect(onRenameWorkspace).not.toHaveBeenCalled();
      promptSpy.mockRestore();
    });
  });

  describe("terminal board", () => {
    function renderTerminalView(terminal = makeTerminalState()) {
      render(
        <MobilePrototype workspaces={[makeWorkspace()]} terminal={terminal as never} />
      );
      // 底部导航切到终端
      const nav = screen.getByRole("navigation");
      fireEvent.click(Array.from(nav.querySelectorAll("button"))[2]);
      return terminal;
    }

    it("renders the real terminal content for an active terminal tab", () => {
      renderTerminalView();
      expect(screen.getByTestId("terminal-content")).toHaveTextContent("app (Claude)");
    });

    it("submits trimmed input on Enter and clears the field", async () => {
      const user = userEvent.setup();
      const terminal = renderTerminalView();

      const input = screen.getByPlaceholderText("输入命令或消息...");
      await user.type(input, "  git status  {Enter}");
      await waitFor(() => {
        expect(terminal.onSubmit).toHaveBeenCalledWith("sess-1", "git status");
      });
      expect((input as HTMLInputElement).value).toBe("");
    });

    it("restores the draft and shows an error when submit fails", async () => {
      const user = userEvent.setup();
      const terminal = makeTerminalState({
        onSubmit: vi.fn().mockRejectedValue(new Error("io")),
      });
      renderTerminalView(terminal);

      const input = screen.getByPlaceholderText("输入命令或消息...");
      await user.type(input, "ls{Enter}");
      expect(await screen.findByText("发送失败")).toBeInTheDocument();
      expect((input as HTMLInputElement).value).toBe("ls");
    });

    it("writes shortcut characters directly to the session", async () => {
      const user = userEvent.setup();
      const terminal = renderTerminalView();
      await user.click(screen.getByLabelText("输入 /"));
      expect(terminal.onWrite).toHaveBeenCalledWith("sess-1", "/");
    });

    it("disables input and send without an active session", () => {
      renderTerminalView(makeTerminalState({ tab: terminalTab({ sessionId: null }) }));
      expect(screen.getByPlaceholderText("等待终端会话...")).toBeDisabled();
      expect(screen.getByLabelText("发送到终端")).toBeDisabled();
    });

    it("keeps the send button disabled until something is typed", async () => {
      const user = userEvent.setup();
      renderTerminalView();
      const send = screen.getByLabelText("发送到终端");
      expect(send).toBeDisabled();
      await user.type(screen.getByPlaceholderText("输入命令或消息..."), "x");
      expect(send).toBeEnabled();
    });
  });
});

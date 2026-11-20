import { fireEvent, render, screen } from "@testing-library/react";
import { usePanesStore } from "@/stores";
import type { Tab } from "@/types";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import WorkspaceTerminalList from "./WorkspaceTerminalList";
import type { WorkspaceTerminalRow } from "./workspaceTerminals";

const focusTab = vi.fn();
vi.mock("@/hooks/useFocusTab", () => ({
  focusTab: (tabId: string) => focusTab(tabId),
}));

const openLauncher = vi.fn();
vi.mock("@/stores", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/stores")>();
  return {
    ...original,
    useDialogStore: Object.assign(
      (selector: (s: unknown) => unknown) => selector({ openLauncher }),
      { getState: () => ({ openLauncher }) },
    ),
  };
});

function row(overrides: Partial<WorkspaceTerminalRow> = {}): WorkspaceTerminalRow {
  return {
    tabId: "tab-1",
    layoutId: "l1",
    title: "cc-book (Claude)",
    firstPrompt: null,
    sessionTitle: null,
    titleRenamed: false,
    pinned: false,
    status: "thinking",
    toolName: null,
    oscProgress: null,
    sessionCount: 1,
    ...overrides,
  };
}

describe("WorkspaceTerminalList", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows empty hint with a launch action targeting the workspace", async () => {
    const user = userEvent.setup();
    render(<WorkspaceTerminalList workspaceName="ws-alpha" rows={[]} />);
    expect(screen.getByText(i18n.t("sidebar:noRunningTerminals"))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: i18n.t("sidebar:launchTerminal") }));
    expect(openLauncher).toHaveBeenCalledWith({ workspaceName: "ws-alpha" });
  });

  it("renders title, keeps routine status out of the row text and focuses the tab on click", async () => {
    const user = userEvent.setup();
    render(<WorkspaceTerminalList workspaceName="ws-alpha" rows={[row()]} />);
    const thinking = i18n.t("dialogs:statusThinking");
    const item = screen.getByRole("button", { name: new RegExp(`cc-book.*${thinking}`) });
    expect(item).not.toHaveTextContent(thinking);
    await user.click(item);
    expect(focusTab).toHaveBeenCalledWith("tab-1");
  });

  it("shows the status word for states that need attention", () => {
    render(<WorkspaceTerminalList workspaceName="ws-alpha" rows={[row({ status: "waitingInput" })]} />);
    expect(screen.getByRole("button", { name: /cc-book/ })).toHaveTextContent(
      i18n.t("dialogs:statusWaitingInput"),
    );
  });

  it("prefers the first prompt as row name with title moved to the tooltip", () => {
    render(
      <WorkspaceTerminalList
        workspaceName="ws-alpha"
        rows={[row({ firstPrompt: "修复恢复日志的中文化问题" })]}
      />,
    );
    expect(screen.getByText("修复恢复日志的中文化问题")).toBeInTheDocument();
    expect(screen.queryByText("cc-book (Claude)")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /修复恢复日志/ })).toHaveAttribute(
      "title",
      expect.stringContaining("cc-book (Claude)"),
    );
  });

  it("prefers the CLI session title over the first prompt, which moves to the tooltip", () => {
    render(
      <WorkspaceTerminalList
        workspaceName="ws-alpha"
        rows={[row({ sessionTitle: "起草授权委托书", firstPrompt: "帮我做个空白的授权委托书" })]}
      />,
    );
    const item = screen.getByRole("button", { name: /起草授权委托书/ });
    expect(item).toHaveTextContent("起草授权委托书");
    expect(item).toHaveAttribute("title", expect.stringContaining("帮我做个空白的授权委托书"));
  });

  it("a manual rename beats the CLI title", () => {
    render(
      <WorkspaceTerminalList
        workspaceName="ws-alpha"
        rows={[row({ title: "我的命名", titleRenamed: true, sessionTitle: "自动标题" })]}
      />,
    );
    expect(screen.getByRole("button", { name: /我的命名/ })).toBeInTheDocument();
    expect(screen.queryByText("自动标题")).not.toBeInTheDocument();
  });

  it("lists pinned terminals first", () => {
    render(
      <WorkspaceTerminalList
        workspaceName="ws-alpha"
        rows={[row({ tabId: "a", title: "普通" }), row({ tabId: "b", title: "置顶的", pinned: true })]}
      />,
    );
    const names = screen.getAllByRole("button").map((button) => button.textContent);
    expect(names[0]).toContain("置顶的");
  });

  it("right-click offers the session actions and rename edits inline", async () => {
    const tab = { id: "tab-1", title: "cc-book (Claude)", contentType: "terminal", projectId: "p", projectPath: "/w/cc-book", sessionId: "s1", resumeId: "cli-1" } as Tab;
    const renameTab = vi.fn();
    const original = usePanesStore.getState();
    usePanesStore.setState({
      findTabAcrossLayouts: () => ({ tab, panel: { id: "pane-1" }, layoutId: "l1" }) as never,
      renameTab,
    });
    focusTab.mockReturnValue(true);
    try {
      render(<WorkspaceTerminalList workspaceName="ws-alpha" rows={[row()]} />);
      fireEvent.contextMenu(screen.getByRole("button", { name: /cc-book/ }));
      expect(await screen.findByRole("menuitem", { name: /重命名|Rename/ })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: /置顶|Pin/ })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: /关闭|Close/ })).toBeInTheDocument();

      fireEvent.click(screen.getByRole("menuitem", { name: /重命名|Rename/ }));
      const input = await screen.findByRole("textbox");
      fireEvent.change(input, { target: { value: "新名字" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(renameTab).toHaveBeenCalledWith("pane-1", "tab-1", "新名字");
    } finally {
      usePanesStore.setState({ findTabAcrossLayouts: original.findTabAcrossLayouts, renameTab: original.renameTab });
    }
  });

  it("falls back to tab title when no first prompt is known", () => {
    render(<WorkspaceTerminalList workspaceName="ws-alpha" rows={[row()]} />);
    expect(screen.getByText("cc-book (Claude)")).toBeInTheDocument();
  });

  it("shows split count only for multi-session tabs", () => {
    render(
      <WorkspaceTerminalList
        workspaceName="ws-alpha"
        rows={[row({ tabId: "t1", sessionCount: 1 }), row({ tabId: "t2", sessionCount: 3, title: "split" })]}
      />,
    );
    const splitLabel = i18n.t("sidebar:terminalSplitCount", { count: 3 });
    expect(screen.getByText(splitLabel)).toBeInTheDocument();
    expect(screen.getAllByText(splitLabel)).toHaveLength(1);
  });
});

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
    kind: "terminal",
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
    projectName: "cc-book",
    engines: ["claude"],
    lastActivityAt: null,
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

  it("renders a two-line card with project, status word and engine, and focuses the tab on click", async () => {
    const user = userEvent.setup();
    render(<WorkspaceTerminalList workspaceName="ws-alpha" rows={[row({ firstPrompt: "修个 bug" })]} />);
    const thinking = i18n.t("dialogs:statusThinking");
    const item = screen.getByRole("button", { name: new RegExp(`修个 bug.*cc-book.*${thinking}`) });
    // 状态不只靠颜色：有状态词 + 形状标记
    expect(item).toHaveTextContent(thinking);
    expect(item.querySelector("[data-shape]")).not.toBeNull();
    expect(item.querySelector("[data-project-avatar]")).toHaveTextContent("CB");
    expect(item.querySelector("[data-cli-brand='claude']")).not.toBeNull();
    await user.click(item);
    expect(focusTab).toHaveBeenCalledWith("tab-1");
  });

  it("renders engines in order (most recent on the right) and a relative time with absolute tooltip", () => {
    const at = Date.now() - 5 * 60_000;
    render(
      <WorkspaceTerminalList
        workspaceName="ws-alpha"
        rows={[row({ engines: ["codex", "claude"], lastActivityAt: at })]}
      />,
    );
    const item = screen.getByRole("button", { name: /cc-book/ });
    const brands = [...item.querySelectorAll("[data-cli-brand]")].map((node) => node.getAttribute("data-cli-brand"));
    expect(brands).toEqual(["codex", "claude"]);
    const time = item.querySelector("time");
    expect(time).toHaveTextContent("5m");
    expect(time?.getAttribute("title")).toContain(new Date(at).toLocaleString());
  });

  it("moves focus between cards with the arrow keys", () => {
    render(
      <WorkspaceTerminalList
        workspaceName="ws-alpha"
        rows={[row({ tabId: "a", title: "第一个" }), row({ tabId: "b", title: "第二个" })]}
      />,
    );
    const [first, second] = screen.getAllByRole("button");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: "ArrowUp" });
    expect(first).toHaveFocus();
  });

  it("marks the active tab with a raised background instead of a side bar", () => {
    const original = usePanesStore.getState();
    usePanesStore.setState({
      rootPane: { type: "panel", id: "p1", tabs: [], activeTabId: "tab-1" } as never,
      activePaneId: "p1",
    });
    try {
      render(<WorkspaceTerminalList workspaceName="ws-alpha" rows={[row()]} />);
      const item = screen.getByRole("button", { name: /cc-book/ });
      expect(item).toHaveAttribute("aria-current", "true");
      expect(item.className).toContain("bg-[var(--app-active-bg)]");
      expect(item.className).not.toMatch(/border-l|before:/);
    } finally {
      usePanesStore.setState({ rootPane: original.rootPane, activePaneId: original.activePaneId });
    }
  });

  it("shows the status word for states that need attention", () => {
    render(<WorkspaceTerminalList workspaceName="ws-alpha" rows={[row({ status: "waitingInput" })]} />);
    expect(screen.getByRole("button", { name: /cc-book/ })).toHaveTextContent(
      i18n.t("dialogs:statusWaitingInput"),
    );
  });

  it("prefers the first prompt as card title with the tab title moved to the tooltip", () => {
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

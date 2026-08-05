import { render, screen } from "@testing-library/react";
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
    status: "thinking",
    toolName: null,
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

  it("renders title, status word and focuses the tab on click", async () => {
    const user = userEvent.setup();
    render(<WorkspaceTerminalList workspaceName="ws-alpha" rows={[row()]} />);
    const item = screen.getByRole("button", { name: new RegExp("cc-book") });
    expect(item).toHaveTextContent(i18n.t("dialogs:statusThinking"));
    await user.click(item);
    expect(focusTab).toHaveBeenCalledWith("tab-1");
  });

  it("prefers the first prompt as row name with title demoted to second line", () => {
    render(
      <WorkspaceTerminalList
        workspaceName="ws-alpha"
        rows={[row({ firstPrompt: "修复恢复日志的中文化问题" })]}
      />,
    );
    expect(screen.getByText("修复恢复日志的中文化问题")).toBeInTheDocument();
    expect(screen.getByText("cc-book (Claude)")).toBeInTheDocument();
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

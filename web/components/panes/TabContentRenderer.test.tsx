import "@/i18n";
import i18n from "i18next";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "@/types";
import { usePanesStore } from "@/stores";
import { markTabReclaimed } from "@/services";
import TabContentRenderer from "./TabContentRenderer";

vi.mock("./TerminalTabContent", () => ({
  default: ({ tab, isVisible, isActive, showStatusBar }: {
    tab: Tab;
    isVisible: boolean;
    isActive: boolean;
    showStatusBar?: boolean;
  }) => (
    <div
      data-testid="terminal-tab-content"
      data-tab-id={tab.id}
      data-visible={String(isVisible)}
      data-active={String(isActive)}
      data-status-bar={String(Boolean(showStatusBar))}
    />
  ),
}));

vi.mock("./BrowserTabContent", () => ({
  default: ({ tab, isVisible, isActive }: { tab: Tab; isVisible: boolean; isActive: boolean }) => (
    <div
      data-testid="browser-tab-content"
      data-tab-id={tab.id}
      data-visible={String(isVisible)}
      data-active={String(isActive)}
    />
  ),
}));

vi.mock("@/services/popupWindowService", () => ({
  popOutTab: vi.fn(),
  isTabPoppedOut: vi.fn(() => false),
  markTabReclaimed: vi.fn(),
  getPoppedTabs: vi.fn(() => []),
}));

vi.mock("@/components/settings/ProjectMcpSection", () => ({
  default: ({ projectPath }: { projectPath: string }) => (
    <div data-testid="mcp-config" data-project-path={projectPath} />
  ),
}));
vi.mock("@/components/skill/SkillManager", () => ({
  default: () => <div data-testid="skill-manager" />,
}));
vi.mock("@/components/memory/MemoryManager", () => ({
  default: () => <div data-testid="memory-manager" />,
}));
vi.mock("@/components/explorer/FileExplorerView", () => ({
  default: ({ projectPath }: { projectPath: string }) => (
    <div data-testid="file-explorer" data-project-path={projectPath} />
  ),
}));
vi.mock("@/components/editor/EditorView", () => ({
  default: ({ filePath, tabId, paneId }: { filePath: string; tabId: string; paneId: string }) => (
    <div data-testid="editor-view" data-file-path={filePath} data-tab-id={tabId} data-pane-id={paneId} />
  ),
}));

function makeTab(overrides?: Partial<Tab>): Tab {
  return {
    id: "tab-1",
    title: "Tab",
    contentType: "terminal",
    projectId: "proj-1",
    projectPath: "/tmp/proj",
    sessionId: null,
    ...overrides,
  } as Tab;
}

function renderContent(tab: Tab, options?: { isPoppedOut?: boolean; showTerminalStatusBar?: boolean }) {
  return render(
    <TabContentRenderer
      tab={tab}
      isVisible
      isActive
      layoutActive
      showTerminalStatusBar={options?.showTerminalStatusBar}
      paneId="pane-1"
      isPoppedOut={options?.isPoppedOut}
      onSessionCreated={vi.fn()}
      onSessionExited={vi.fn()}
      onTerminalRef={vi.fn()}
    />
  );
}

describe("TabContentRenderer", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders terminal content for a terminal tab with a project path", () => {
    renderContent(makeTab());

    const terminal = screen.getByTestId("terminal-tab-content");
    expect(terminal).toHaveAttribute("data-tab-id", "tab-1");
    expect(terminal).toHaveAttribute("data-visible", "true");
    expect(terminal).toHaveAttribute("data-active", "true");
  });

  it("renders nothing for a terminal tab without a project path", () => {
    const { container } = renderContent(makeTab({ projectPath: "" }));

    expect(container).toBeEmptyDOMElement();
  });

  it("forwards the grid status-bar flag to terminal content", () => {
    renderContent(makeTab(), { showTerminalStatusBar: true });

    expect(screen.getByTestId("terminal-tab-content")).toHaveAttribute("data-status-bar", "true");
  });

  it("shows the popped-out placeholder and reclaims via store and service", async () => {
    const user = userEvent.setup();
    const storeMarkTabReclaimed = vi.fn();
    usePanesStore.setState({ markTabReclaimed: storeMarkTabReclaimed });

    renderContent(makeTab(), { isPoppedOut: true });

    expect(screen.queryByTestId("terminal-tab-content")).not.toBeInTheDocument();
    expect(screen.getByText(i18n.t("poppedOutPlaceholder", { ns: "panes" }))).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: new RegExp(i18n.t("reclaimTab", { ns: "panes" })) }));

    expect(storeMarkTabReclaimed).toHaveBeenCalledWith("tab-1");
    expect(vi.mocked(markTabReclaimed)).toHaveBeenCalledWith("tab-1");
  });

  it("renders the file explorer for a file-explorer tab", async () => {
    renderContent(makeTab({ contentType: "file-explorer" }));

    expect(await screen.findByTestId("file-explorer")).toHaveAttribute(
      "data-project-path",
      "/tmp/proj"
    );
  });

  it("renders nothing for an editor tab missing a file path", () => {
    const { container } = renderContent(makeTab({ contentType: "editor" }));

    expect(container).toBeEmptyDOMElement();
  });

  it("renders the editor with file, tab and pane wiring", async () => {
    renderContent(makeTab({ contentType: "editor", filePath: "/tmp/proj/a.ts" }));

    const editor = await screen.findByTestId("editor-view");
    expect(editor).toHaveAttribute("data-file-path", "/tmp/proj/a.ts");
    expect(editor).toHaveAttribute("data-tab-id", "tab-1");
    expect(editor).toHaveAttribute("data-pane-id", "pane-1");
  });

  it("renders the MCP config panel for an mcp-config tab", async () => {
    renderContent(makeTab({ contentType: "mcp-config" }));

    expect(await screen.findByTestId("mcp-config")).toHaveAttribute(
      "data-project-path",
      "/tmp/proj"
    );
  });

  it("renders skill and memory managers for their tab types", async () => {
    renderContent(makeTab({ contentType: "skill-manager" }));
    expect(await screen.findByTestId("skill-manager")).toBeInTheDocument();

    renderContent(makeTab({ contentType: "memory-manager" }));
    expect(await screen.findByTestId("memory-manager")).toBeInTheDocument();
  });

  it("renders nothing for an unknown content type", () => {
    const { container } = renderContent(makeTab({ contentType: "unknown" as Tab["contentType"] }));

    expect(container).toBeEmptyDOMElement();
  });

  it("renders browser content with visibility and active state", async () => {
    renderContent(makeTab({
      contentType: "browser",
      browserUrl: "http://localhost:5173/",
    }));

    const browser = await screen.findByTestId("browser-tab-content");
    expect(browser).toHaveAttribute("data-tab-id", "tab-1");
    expect(browser).toHaveAttribute("data-visible", "true");
    expect(browser).toHaveAttribute("data-active", "true");
  });
});

import "@/i18n";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Tab } from "@/types";
import TerminalTabContent from "./TerminalTabContent";

vi.mock("./TerminalView", () => ({
  default: vi.fn(() => <div data-testid="terminal-view" />),
}));

vi.mock("./SplitView", () => ({
  default: ({ children }: { children: React.ReactNode[] }) => <div>{children}</div>,
}));

function createTerminalTab(overrides?: Partial<Tab>): Tab {
  return {
    id: "tab-1",
    title: "project",
    contentType: "terminal",
    projectId: "project-1",
    projectPath: "/tmp/project",
    sessionId: null,
    terminalRootPane: {
      type: "leaf",
      id: "leaf-1",
      sessionId: null,
    },
    activeTerminalPaneId: "leaf-1",
    ...overrides,
  };
}

describe("TerminalTabContent", () => {
  it("shows ready overlay for a leaf without a session", () => {
    render(
      <TerminalTabContent
        tab={createTerminalTab()}
        isActive
        onSessionCreated={vi.fn()}
        onSessionExited={vi.fn()}
        onTerminalRef={vi.fn()}
      />
    );

    expect(screen.getByText("准备就绪")).toBeVisible();
  });

  it("hides ready overlay once the leaf has a session", () => {
    render(
      <TerminalTabContent
        tab={createTerminalTab({
          sessionId: "session-1",
          terminalRootPane: {
            type: "leaf",
            id: "leaf-1",
            sessionId: "session-1",
          },
        })}
        isActive
        onSessionCreated={vi.fn()}
        onSessionExited={vi.fn()}
        onTerminalRef={vi.fn()}
      />
    );

    expect(screen.queryByText("准备就绪")).not.toBeInTheDocument();
  });

  it("hides ready overlay while a leaf is restoring", () => {
    render(
      <TerminalTabContent
        tab={createTerminalTab({
          terminalRootPane: {
            type: "leaf",
            id: "leaf-1",
            sessionId: null,
            restoring: true,
          },
        })}
        isActive
        onSessionCreated={vi.fn()}
        onSessionExited={vi.fn()}
        onTerminalRef={vi.fn()}
      />
    );

    expect(screen.queryByText("准备就绪")).not.toBeInTheDocument();
  });
});

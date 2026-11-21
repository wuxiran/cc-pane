import "@/i18n";
import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getVersion } from "@tauri-apps/api/app";
import packageJson from "../../../package.json";
import { isTauriRuntime } from "@/services/runtime";
import { waitForTauri } from "@/utils";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useDialogStore } from "@/stores";
import HomeDashboard from "./HomeDashboard";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(),
}));

vi.mock("@/services/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/runtime")>();
  return { ...actual, isTauriRuntime: vi.fn(() => false) };
});

vi.mock("@/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils")>();
  return { ...actual, waitForTauri: vi.fn(async () => true) };
});

vi.mock("./HomeHeader", () => ({
  default: ({ version, actions }: { version: string; actions?: ReactNode }) => (
    <div data-testid="header">
      {version}
      {actions}
    </div>
  ),
}));
vi.mock("./HomeAgentPrompt", () => ({
  default: () => <div data-testid="agent-prompt" />,
}));
vi.mock("./HomeQuickStart", () => ({
  default: () => <div data-testid="quick-start" />,
}));
vi.mock("./HomeAgentList", () => ({
  default: () => <div data-testid="agent-list" />,
}));
vi.mock("./HomeAgentInstall", () => ({
  default: () => <div data-testid="agent-install" />,
}));
vi.mock("./HomeActiveSessions", () => ({
  default: () => <div data-testid="active-sessions" />,
}));
vi.mock("@/hooks/useCliTools", () => ({
  useCliTools: () => ({
    tools: [],
    installedTools: [],
    loading: false,
    refresh: vi.fn(async () => undefined),
    getToolById: () => undefined,
  }),
}));

describe("HomeDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isTauriRuntime).mockReturnValue(false);
    vi.mocked(waitForTauri).mockResolvedValue(true);
    useActivityBarStore.setState({ appViewMode: "home", sidebarVisible: false });
  });

  it("uses the package version outside Tauri", async () => {
    render(<HomeDashboard onOpenTerminal={vi.fn()} />);

    expect(await screen.findByText(packageJson.version)).toBeInTheDocument();
  });

  it("uses getVersion in Tauri", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    vi.mocked(getVersion).mockResolvedValue("9.9.9");
    render(<HomeDashboard onOpenTerminal={vi.fn()} />);

    expect(await screen.findByText("9.9.9")).toBeInTheDocument();
  });

  it("switches to panes and expands the sidebar when entering the workspace", async () => {
    render(<HomeDashboard onOpenTerminal={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: /打开工作空间/ }));

    expect(useActivityBarStore.getState().appViewMode).toBe("panes");
    expect(useActivityBarStore.getState().sidebarVisible).toBe(true);
  });

  it("opens the launcher from the header new-terminal button", () => {
    render(<HomeDashboard onOpenTerminal={vi.fn()} />);

    fireEvent.click(screen.getByTestId("home-new-terminal"));

    expect(useDialogStore.getState().launcherOpen).toBe(true);
  });

  it("renders the magpie-style sections in order: prompt, quick start, agents, install, then workbench rail", () => {
    render(<HomeDashboard onOpenTerminal={vi.fn()} />);

    const order = ["agent-prompt", "quick-start", "agent-list", "agent-install", "home-workbench"].map((id) =>
      screen.getByTestId(id),
    );
    for (let index = 1; index < order.length; index += 1) {
      expect(order[index - 1].compareDocumentPosition(order[index]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(screen.getByTestId("active-sessions")).toBeInTheDocument();
  });
});

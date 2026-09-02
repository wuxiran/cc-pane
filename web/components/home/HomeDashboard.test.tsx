import "@/i18n";
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
  default: ({ version }: { version: string }) => <div data-testid="header">{version}</div>,
}));
vi.mock("./HomeQuickActions", () => ({
  default: ({ onNewTerminal }: { onNewTerminal: () => void }) => (
    <button data-testid="quick-actions" onClick={onNewTerminal} />
  ),
}));
vi.mock("./HomeDesignHighlights", () => ({
  default: ({ compact }: { compact?: boolean }) => (
    <div data-testid={compact ? "highlights-compact" : "highlights-card"} />
  ),
}));
vi.mock("./HomeActiveSessions", () => ({
  default: () => <div data-testid="active-sessions" />,
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

    fireEvent.click(await screen.findByRole("button", { name: /进入工作区/ }));

    expect(useActivityBarStore.getState().appViewMode).toBe("panes");
    expect(useActivityBarStore.getState().sidebarVisible).toBe(true);
  });

  it("opens the launcher from the new terminal quick action", () => {
    render(<HomeDashboard onOpenTerminal={vi.fn()} />);

    fireEvent.click(screen.getByTestId("quick-actions"));

    expect(useDialogStore.getState().launcherOpen).toBe(true);
  });

  it("renders welcome, quick actions, active sessions and the compact product overview", () => {
    render(<HomeDashboard onOpenTerminal={vi.fn()} />);

    expect(screen.getByTestId("header")).toBeInTheDocument();
    expect(screen.getByTestId("quick-actions")).toBeInTheDocument();
    expect(screen.getByTestId("active-sessions")).toBeInTheDocument();
    expect(screen.getByTestId("highlights-compact")).toBeInTheDocument();
    expect(screen.queryByTestId("highlights-card")).not.toBeInTheDocument();
  });
});

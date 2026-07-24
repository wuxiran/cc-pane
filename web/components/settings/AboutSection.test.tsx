import "@/i18n";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getVersion } from "@tauri-apps/api/app";
import packageJson from "../../../package.json";
import { logService } from "@/services";
import { settingsService } from "@/services/settingsService";
import { checkForAppUpdates } from "@/services/updaterService";
import { isTauriRuntime } from "@/services/runtime";
import { useUpdateStore } from "@/stores";
import AboutSection from "./AboutSection";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(async () => "9.9.9"),
}));

vi.mock("@/services/runtime", () => ({
  isTauriRuntime: vi.fn(() => true),
  isWebRuntime: vi.fn(() => false),
  invokeIfTauri: vi.fn(async () => undefined),
  listenIfTauri: vi.fn(async () => () => {}),
  listenWebviewIfTauri: vi.fn(async () => () => {}),
  getCurrentWindowIfTauri: vi.fn(() => null),
  logErrorSafe: vi.fn(),
  logInfoSafe: vi.fn(),
}));

vi.mock("@/services/logService", () => ({
  logService: {
    openLogDir: vi.fn(async () => {}),
  },
}));

vi.mock("@/services/updaterService", () => ({
  checkForAppUpdates: vi.fn(async () => {}),
  checkUpdateSilent: vi.fn(async () => {}),
  triggerUpdate: vi.fn(async () => {}),
}));

vi.mock("@/services/settingsService", () => ({
  settingsService: {
    cleanupBeforeUninstall: vi.fn(async () => ({
      cleaned: ["~/.claude/commands/ccpanes"],
      skipped: ["D:/missing-project: project unavailable"],
      failed: [],
    })),
  },
}));

describe("AboutSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    useUpdateStore.setState({ available: false, version: null });
  });

  it("shows the Tauri app version in desktop runtime", async () => {
    render(<AboutSection />);
    await act(async () => {});

    expect(await screen.findByText("v9.9.9")).toBeInTheDocument();
    expect(getVersion).toHaveBeenCalled();
  });

  it("falls back to the package.json version outside Tauri and hides desktop buttons", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(false);
    render(<AboutSection />);
    await act(async () => {});

    expect(screen.getByText(`v${packageJson.version}`)).toBeInTheDocument();
    expect(getVersion).not.toHaveBeenCalled();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("triggers a manual update check via the updater service", async () => {
    const user = userEvent.setup();
    render(<AboutSection />);
    await act(async () => {});

    const buttons = screen.getAllByRole("button");
    await user.click(buttons[0]);

    await waitFor(() => expect(checkForAppUpdates).toHaveBeenCalledWith(true));
  });

  it("opens the log directory via the log service", async () => {
    const user = userEvent.setup();
    render(<AboutSection />);
    await act(async () => {});

    const buttons = screen.getAllByRole("button");
    await user.click(buttons[1]);

    await waitFor(() => expect(logService.openLogDir).toHaveBeenCalled());
  });

  it("shows the new-version banner when an update is available", async () => {
    useUpdateStore.setState({ available: true, version: "2.0.0" });
    render(<AboutSection />);
    await act(async () => {});

    expect(screen.getByText(/2\.0\.0/)).toBeInTheDocument();
  });

  it("confirms cleanup and renders the cleanup report", async () => {
    const user = userEvent.setup();
    render(<AboutSection />);
    await act(async () => {});

    await user.click(screen.getByRole("button", { name: /卸载前清理|Cleanup before uninstall/i }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /确认清理|Clean up now/i }));

    await waitFor(() => expect(settingsService.cleanupBeforeUninstall).toHaveBeenCalledTimes(1));
    expect(screen.getByText("~/.claude/commands/ccpanes")).toBeInTheDocument();
    expect(screen.getByText(/D:\/missing-project/)).toBeInTheDocument();
  });

  it("swallows update-check failures without crashing", async () => {
    const user = userEvent.setup();
    vi.mocked(checkForAppUpdates).mockRejectedValue(new Error("network down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<AboutSection />);
    await act(async () => {});

    await user.click(screen.getAllByRole("button")[0]);

    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    consoleError.mockRestore();
  });
});

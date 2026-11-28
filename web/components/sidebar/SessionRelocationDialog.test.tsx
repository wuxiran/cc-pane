import "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDialogStore } from "@/stores";
import type { SessionRelocationReport } from "@/types/sessionRelocation";
import SessionRelocationDialog from "./SessionRelocationDialog";

const relocate = vi.hoisted(() => vi.fn());
vi.mock("@/services/sessionRelocationService", () => ({ sessionRelocationService: { relocate } }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));

function report(over: Partial<SessionRelocationReport> = {}): SessionRelocationReport {
  return {
    dryRun: true,
    oldPath: "/work/old",
    newPath: "/work/new",
    claudeSessions: 3,
    codexSessions: 1,
    skipped: [{ cli: "claude", sessionId: "dup", reason: "exists" }],
    launchHistoryRows: 2,
    taskBindingRows: 0,
    warnings: [],
    ...over,
  };
}

beforeEach(() => {
  relocate.mockReset();
  useDialogStore.getState().openSessionRelocation({ oldPath: "", newPath: "/work/new" });
});

describe("SessionRelocationDialog", () => {
  it("previews first, then migrates the previewed paths", async () => {
    const user = userEvent.setup();
    relocate.mockResolvedValueOnce(report()).mockResolvedValueOnce(report({ dryRun: false, backupDir: "/bk/1" }));
    render(<SessionRelocationDialog />);

    const execute = screen.getByTestId("session-relocation-execute");
    expect(execute).toBeDisabled();
    expect(screen.getByTestId("session-relocation-preview")).toBeDisabled();

    await user.type(screen.getByLabelText(/旧路径/), "/work/old");
    await user.click(screen.getByTestId("session-relocation-preview"));
    expect(relocate).toHaveBeenCalledWith({ oldPath: "/work/old", newPath: "/work/new", dryRun: true });
    expect(await screen.findByTestId("session-relocation-report")).toHaveTextContent("新路径下已有同名会话");
    await waitFor(() => expect(execute).toBeEnabled());

    await user.click(execute);
    expect(relocate).toHaveBeenLastCalledWith({ oldPath: "/work/old", newPath: "/work/new", dryRun: false });
    expect(await screen.findByText("备份：/bk/1")).toBeInTheDocument();
  });

  it("requires a fresh preview after the paths change", async () => {
    const user = userEvent.setup();
    relocate.mockResolvedValue(report());
    render(<SessionRelocationDialog />);
    await user.type(screen.getByLabelText(/旧路径/), "/work/old");
    await user.click(screen.getByTestId("session-relocation-preview"));
    await waitFor(() => expect(screen.getByTestId("session-relocation-execute")).toBeEnabled());
    await user.type(screen.getByLabelText(/旧路径/), "-2");
    expect(screen.getByTestId("session-relocation-execute")).toBeDisabled();
  });

  it("keeps migrate disabled when the preview finds nothing", async () => {
    const user = userEvent.setup();
    relocate.mockResolvedValue(report({ claudeSessions: 0, codexSessions: 0, launchHistoryRows: 0, skipped: [] }));
    render(<SessionRelocationDialog />);
    await user.type(screen.getByLabelText(/旧路径/), "/work/old");
    await user.click(screen.getByTestId("session-relocation-preview"));
    await screen.findByTestId("session-relocation-report");
    expect(screen.getByTestId("session-relocation-execute")).toBeDisabled();
  });
});

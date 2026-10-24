import "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDialogStore } from "@/stores/useDialogStore";
import { prepareLocalSessionCwd } from "@/services/localLaunchService";
import { toastErr } from "@/lib/feedback";
import LauncherDialog from "./LauncherDialog";
import type { LauncherDraft, LauncherProjectSource } from "./launcherModel";

vi.mock("@/services/localLaunchService", () => ({ prepareLocalSessionCwd: vi.fn() }));
vi.mock("@/lib/feedback", () => ({ toastErr: vi.fn() }));
vi.mock("./LauncherProjectPicker", () => ({ default: ({ onChange }: { onChange: (source: LauncherProjectSource) => void }) =>
  <button onClick={() => onChange({ kind: "manual", path: "/repo" })}>Choose project</button> }));
vi.mock("./LauncherWorktreeRow", () => ({ default: ({ onChange }: { onChange: (patch: Partial<LauncherDraft>) => void }) =>
  <button onClick={() => onChange({ worktree: { enabled: true, branch: "cc/task", baseRef: "refs/heads/main" } })}>Configure worktree</button> }));
vi.mock("./LauncherCliRow", () => ({ default: () => null }));
vi.mock("./LauncherScenarioRow", () => ({ default: () => null }));
vi.mock("./LauncherChips", () => ({ default: () => null }));
vi.mock("./LauncherInjectionRow", () => ({ default: () => null }));
vi.mock("./LauncherLayoutRow", () => ({ default: () => null }));
vi.mock("./LauncherArgsPreviewView", () => ({ default: () => null }));
vi.mock("./CcchanPeek", () => ({ default: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
  useDialogStore.setState({ pendingLaunch: null, launcherOpen: true, launcherContext: null });
});
async function setup() {
  render(<LauncherDialog />);
  await userEvent.click(screen.getByRole("button", { name: "Choose project" }));
  await userEvent.click(screen.getByRole("button", { name: "Configure worktree" }));
}

describe("CLI configured launch", () => {
  it("waits for worktree creation, locks the draft, and dispatches the actual cwd once", async () => {
    let finish!: (path: string) => void;
    vi.mocked(prepareLocalSessionCwd).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await setup();
    await userEvent.click(screen.getByRole("button", { name: "启动" }));
    expect(useDialogStore.getState().pendingLaunch).toBeNull();
    expect(screen.getByRole("button", { name: "Choose project" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "启动中…" }));
    expect(prepareLocalSessionCwd).toHaveBeenCalledExactlyOnceWith("/repo", {
      enabled: true, branch: "cc/task", baseRef: "refs/heads/main",
    });
    await act(async () => finish("/repo-worktrees/cc-task"));
    await waitFor(() => expect(useDialogStore.getState().pendingLaunch?.path).toBe("/repo-worktrees/cc-task"));
    expect(useDialogStore.getState().pendingLaunch?.launchCwd).toBe("/repo-worktrees/cc-task");
    expect(useDialogStore.getState().launcherOpen).toBe(false);
  });
  it("keeps the configuration after creation fails and dispatches no source-directory launch", async () => {
    vi.mocked(prepareLocalSessionCwd).mockRejectedValue(new Error("invalid base"));
    await setup();
    await userEvent.click(screen.getByRole("button", { name: "启动" }));
    await waitFor(() => expect(toastErr).toHaveBeenCalled());
    expect(useDialogStore.getState().pendingLaunch).toBeNull();
    expect(useDialogStore.getState().launcherOpen).toBe(true);
    expect(screen.getByRole("button", { name: "启动" })).toBeEnabled();
  });
});

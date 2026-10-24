import "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LauncherWorktreeRow from "./LauncherWorktreeRow";
import LocalLaunchSettings from "./LocalLaunchSettings";
import { createDefaultDraft } from "./launcherModel";
import { gitService } from "@/services/gitService";

vi.mock("@/services/gitService", () => ({ gitService: {
  getRepoInfo: vi.fn(), getLocalBranches: vi.fn(),
} }));
vi.mock("./LauncherProviderRow", () => ({ default: () => <div>existing profile selector</div> }));
const info = { state: "ok" as const, branch: "main", repoRoot: "/repo", hasChanges: true };
const openSettings = async () => userEvent.click(screen.getByRole("button", { name: "配置启动环境" }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(gitService.getRepoInfo).mockResolvedValue(info);
  vi.mocked(gitService.getLocalBranches).mockResolvedValue(["main", "feature"]);
});

describe("shared launch environment", () => {
  it("retains CLI environment and profile controls while remote worktrees are disabled", async () => {
    render(<LauncherWorktreeRow draft={createDefaultDraft({ environment: "ssh" })}
      onChange={vi.fn()} projectPath="/repo" isLocal={false} />);
    await openSettings();
    expect(screen.getByRole("switch")).toBeDisabled();
    expect(screen.getByRole("radio", { name: "SSH" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("existing profile selector")).toBeInTheDocument();
    expect(gitService.getRepoInfo).not.toHaveBeenCalled();
  });

  it("disables worktrees for a non-Git directory", async () => {
    vi.mocked(gitService.getRepoInfo).mockResolvedValue({ ...info, state: "notARepo", branch: null });
    render(<LocalLaunchSettings projectPath="/plain" onChange={vi.fn()} />);
    await openSettings();
    await waitFor(() => expect(screen.getByTestId("worktree-reason")).toHaveTextContent("该目录不是 Git 仓库"));
    expect(screen.getByRole("switch")).toBeDisabled();
  });

  it("keeps the current checkout read-only and chooses a base only for a new worktree", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<LocalLaunchSettings projectPath="/repo" onChange={onChange} />);
    await openSettings();
    const toggle = screen.getByRole("switch");
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith({ enabled: true, branch: expect.stringMatching(/^cc\//), baseRef: "HEAD" });
    rerender(<LocalLaunchSettings projectPath="/repo" onChange={onChange}
      worktree={{ enabled: true, branch: "cc/task", baseRef: "HEAD" }} />);
    await waitFor(() => expect(screen.getByRole("option", { name: "feature" })).toBeInTheDocument());
    fireEvent.change(screen.getByRole("combobox", { name: "基准分支" }), { target: { value: "refs/heads/feature" } });
    expect(onChange).toHaveBeenLastCalledWith({ enabled: true, branch: "cc/task", baseRef: "refs/heads/feature" });
    expect(screen.getByText(/未提交修改保留在原处/)).toBeInTheDocument();
  });

  it("ignores late Git responses from a previously selected project", async () => {
    let resolveOld!: (value: typeof info) => void;
    vi.mocked(gitService.getRepoInfo).mockImplementation((path) => path === "/old"
      ? new Promise((resolve) => { resolveOld = resolve; })
      : Promise.resolve({ ...info, state: "notARepo", branch: null }));
    const { rerender } = render(<LocalLaunchSettings projectPath="/old" onChange={vi.fn()} />);
    rerender(<LocalLaunchSettings projectPath="/plain" onChange={vi.fn()} />);
    await act(async () => resolveOld(info));
    await openSettings();
    expect(screen.getByRole("switch")).toBeDisabled();
    expect(screen.queryByText("main")).not.toBeInTheDocument();
  });
});

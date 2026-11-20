import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LocalLaunchSettings from "./LocalLaunchSettings";
import { gitService } from "@/services/gitService";

vi.mock("@/services/gitService", () => ({ gitService: {
  getRepoInfo: vi.fn(), getLocalBranches: vi.fn(),
} }));
const repo = (branch: string) => ({ state: "ok" as const, branch, repoRoot: null, hasChanges: false });
const notRepo = { state: "notARepo" as const, branch: null, repoRoot: null, hasChanges: null };
const openSettings = async () => userEvent.click(screen.getByRole("button", { name: "配置启动环境" }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(gitService.getRepoInfo).mockImplementation(async (path) =>
    path === "/ws/app" ? repo("main") : path === "/ws/lib" ? repo("dev") : notRepo);
  vi.mocked(gitService.getLocalBranches).mockResolvedValue(["main", "feature"]);
});

describe("workspace-root worktree target", () => {
  it("preselects the only Git project and creates its worktree from it", async () => {
    const onChange = vi.fn();
    render(<LocalLaunchSettings projectPath="/ws" onChange={onChange}
      workspaceProjects={[{ path: "/ws/app", name: "app" }, { path: "/ws/docs", name: "docs" }]} />);
    await openSettings();
    const select = await screen.findByRole("combobox", { name: "项目" });
    expect(select).toHaveValue("/ws/app");
    expect(screen.queryByRole("option", { name: /docs/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId("worktree-reason")).not.toBeInTheDocument();
    expect(screen.getAllByText("main").length).toBeGreaterThan(0);
    const toggle = screen.getByRole("switch");
    await waitFor(() => expect(toggle).toBeEnabled());
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, repoPath: "/ws/app", baseRef: "HEAD" }));
    expect(gitService.getLocalBranches).toHaveBeenCalledWith("/ws/app");
  });

  it("asks for a project when several are Git repos and follows the selection", async () => {
    const onChange = vi.fn();
    const projects = [{ path: "/ws/app", name: "app" }, { path: "/ws/lib", name: "lib" }];
    const { rerender } = render(<LocalLaunchSettings projectPath="/ws" onChange={onChange} workspaceProjects={projects} />);
    await openSettings();
    await waitFor(() => expect(screen.getByTestId("worktree-reason")).toHaveTextContent("选择其中一个项目"));
    expect(screen.getByRole("switch")).toBeDisabled();
    fireEvent.change(screen.getByRole("combobox", { name: "项目" }), { target: { value: "/ws/lib" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false, repoPath: "/ws/lib" }));
    rerender(<LocalLaunchSettings projectPath="/ws" onChange={onChange} workspaceProjects={projects}
      worktree={{ enabled: false, branch: "cc/x", baseRef: "HEAD", repoPath: "/ws/lib" }} />);
    await waitFor(() => expect(screen.getByRole("switch")).toBeEnabled());
    expect(screen.getAllByText("dev").length).toBeGreaterThan(0);
  });

  it("keeps the not-a-repo message when no workspace project is a Git repo", async () => {
    render(<LocalLaunchSettings projectPath="/ws" onChange={vi.fn()}
      workspaceProjects={[{ path: "/ws/docs", name: "docs" }]} />);
    await openSettings();
    await waitFor(() => expect(screen.getByTestId("worktree-reason")).toHaveTextContent("该目录不是 Git 仓库"));
    expect(screen.queryByRole("combobox", { name: "项目" })).not.toBeInTheDocument();
    expect(screen.getByRole("switch")).toBeDisabled();
  });
});

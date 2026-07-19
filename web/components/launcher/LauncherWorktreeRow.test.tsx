import "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LauncherWorktreeRow from "./LauncherWorktreeRow";
import { createDefaultDraft } from "./launcherModel";
import { worktreeService } from "@/services";

// 边界纪律：禁止真实 git 操作——isGitRepo 全部 mock
vi.mock("@/services", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services")>();
  return {
    ...actual,
    worktreeService: {
      ...actual.worktreeService,
      isGitRepo: vi.fn(),
    },
  };
});

const isGitRepoMock = vi.mocked(worktreeService.isGitRepo);

describe("LauncherWorktreeRow", () => {
  beforeEach(() => {
    isGitRepoMock.mockReset();
  });

  it("非本地环境置灰且不发起 git 检测", () => {
    render(
      <LauncherWorktreeRow
        draft={createDefaultDraft()}
        onChange={vi.fn()}
        projectPath="D:/repos/demo"
        isLocal={false}
      />,
    );
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(screen.getByTestId("worktree-reason")).toBeInTheDocument();
    expect(isGitRepoMock).not.toHaveBeenCalled();
  });

  it("非 Git 仓库置灰并注明原因", async () => {
    isGitRepoMock.mockResolvedValue(false);
    render(
      <LauncherWorktreeRow
        draft={createDefaultDraft()}
        onChange={vi.fn()}
        projectPath="D:/scratch/plain"
        isLocal
      />,
    );
    await waitFor(() => expect(isGitRepoMock).toHaveBeenCalledWith("D:/scratch/plain"));
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(screen.getByTestId("worktree-reason")).toBeInTheDocument();
  });

  it("本地 Git 仓库可勾选，开启时带 cc/<yyMMdd-HHmm> 默认分支", async () => {
    isGitRepoMock.mockResolvedValue(true);
    const onChange = vi.fn();
    render(
      <LauncherWorktreeRow
        draft={createDefaultDraft()}
        onChange={onChange}
        projectPath="D:/repos/demo"
        isLocal
      />,
    );
    const toggle = screen.getByRole("checkbox");
    await waitFor(() => expect(toggle).toBeEnabled());
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith({
      worktree: { enabled: true, branch: expect.stringMatching(/^cc\/\d{6}-\d{4}$/) },
    });
  });

  it("可用性丢失时自动关掉已勾选的 worktree", async () => {
    isGitRepoMock.mockResolvedValue(false);
    const onChange = vi.fn();
    render(
      <LauncherWorktreeRow
        draft={createDefaultDraft({ worktree: { enabled: true, branch: "cc/x" } })}
        onChange={onChange}
        projectPath="D:/scratch/plain"
        isLocal
      />,
    );
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({ worktree: { enabled: false, branch: "cc/x" } }),
    );
  });
});

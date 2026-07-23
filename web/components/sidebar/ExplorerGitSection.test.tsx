import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "@/types";
import ExplorerGitSection from "./ExplorerGitSection";
import { gitService } from "@/services/gitService";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { message?: string }) =>
      values?.message ? `${key}: ${values.message}` : key,
  }),
}));

vi.mock("@/services/gitService", () => ({
  gitService: {
    getRepoInfo: vi.fn(),
    getFileStatuses: vi.fn(),
  },
}));

function workspace(count = 2): Workspace {
  return {
    id: "ws",
    name: "workspace",
    createdAt: "2026-01-01T00:00:00Z",
    projects: Array.from({ length: count }, (_, index) => ({
      id: `project-${index}`,
      path: `/repos/project-${index}`,
    })),
  };
}

const okInfo = (index: number) => ({
  state: "ok" as const,
  repoRoot: `/repos/project-${index}`,
  branch: "main",
  hasChanges: false,
  message: null,
});

describe("ExplorerGitSection C1 loading", () => {
  beforeEach(() => {
    vi.mocked(gitService.getRepoInfo).mockReset();
    vi.mocked(gitService.getFileStatuses).mockReset();
    vi.mocked(gitService.getRepoInfo).mockImplementation(async (path) => {
      const parts = path.split("-");
      const index = Number(parts[parts.length - 1]);
      return okInfo(index);
    });
    vi.mocked(gitService.getFileStatuses).mockResolvedValue({});
  });

  it("折叠态只查询轻量 repo info，不拉文件详情", async () => {
    render(<ExplorerGitSection workspace={workspace()} selectedProjectId={null} />);

    await waitFor(() => expect(gitService.getRepoInfo).toHaveBeenCalledTimes(2));
    expect(gitService.getFileStatuses).not.toHaveBeenCalled();
  });

  it("展开后才拉文件详情，并把详情失败显示出来", async () => {
    vi.mocked(gitService.getFileStatuses).mockRejectedValue(new Error("status failed"));
    render(<ExplorerGitSection workspace={workspace(1)} selectedProjectId={null} />);
    await screen.findByText("main");

    fireEvent.click(screen.getByText("project-0"));

    expect(await screen.findByText("explorer.gitError: status failed")).toBeVisible();
  });

  it.each([
    [{ state: "pathNotFound" as const }, "explorer.gitPathNotFound"],
    [{ state: "notARepo" as const }, "explorer.notGitRepo"],
    [{ state: "gitError" as const, message: "broken index" }, "explorer.gitError: broken index"],
  ])("repo 状态 %o 有明确提示", async (info, expected) => {
    vi.mocked(gitService.getRepoInfo).mockResolvedValue({
      ...info,
      repoRoot: null,
      branch: null,
      hasChanges: null,
      message: "message" in info ? info.message : null,
    });
    render(<ExplorerGitSection workspace={workspace(1)} selectedProjectId="project-0" />);

    expect(await screen.findAllByText(expected)).not.toHaveLength(0);
    expect(gitService.getFileStatuses).not.toHaveBeenCalled();
  });

  it("限制多个展开项目的详情查询并发", async () => {
    let active = 0;
    let maxActive = 0;
    vi.mocked(gitService.getFileStatuses).mockImplementation(
      () =>
        new Promise((resolve) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          setTimeout(() => {
            active -= 1;
            resolve({});
          }, 20);
        }),
    );
    render(<ExplorerGitSection workspace={workspace(8)} selectedProjectId={null} />);
    await waitFor(() => expect(gitService.getRepoInfo).toHaveBeenCalledTimes(8));

    for (let index = 0; index < 8; index += 1) {
      fireEvent.click(screen.getByText(`project-${index}`));
    }

    await waitFor(() => expect(gitService.getFileStatuses).toHaveBeenCalledTimes(8));
    await waitFor(() => expect(active).toBe(0));
    expect(maxActive).toBeLessThanOrEqual(4);
  });
});

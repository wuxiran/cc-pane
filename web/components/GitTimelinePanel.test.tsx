import "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GitTimelinePanel from "./GitTimelinePanel";
import { gitService, type GitChangedFile, type GitLogPage } from "@/services/gitService";

vi.mock("@/services/gitService", () => ({
  gitService: {
    getRepoInfo: vi.fn(),
    getLocalBranches: vi.fn(),
    getLog: vi.fn(),
    listCommitFiles: vi.fn(),
    getDiff: vi.fn(),
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function page(subject: string, hash: string): GitLogPage {
  return {
    commits: [{
      hash,
      shortHash: hash.slice(0, 7),
      author: "User",
      authorEmail: "user@example.com",
      date: "2026-07-24T00:00:00+08:00",
      subject,
      refs: "",
      parents: ["parent"],
    }],
    hasMore: false,
    nextOffset: null,
  };
}

const changedFile: GitChangedFile = {
  status: "modified",
  oldPath: "src/a.ts",
  newPath: "src/a.ts",
  oldMode: "100644",
  newMode: "100644",
};

describe("GitTimelinePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(gitService.getRepoInfo).mockResolvedValue({
      state: "ok",
      repoRoot: "/repo",
      branch: "main",
      hasChanges: true,
    });
    vi.mocked(gitService.getLocalBranches).mockResolvedValue(["main", "feature"]);
    vi.mocked(gitService.listCommitFiles).mockResolvedValue([changedFile]);
    vi.mocked(gitService.getDiff).mockResolvedValue({
      hunks: [],
      stats: { additions: 0, deletions: 0, changes: 0 },
      isBinary: false,
      truncated: false,
      truncationReason: null,
      oldSize: 1,
      newSize: 1,
    });
  });

  it("分支切换丢弃较晚返回的旧 log 响应", async () => {
    const main = deferred<GitLogPage>();
    const feature = deferred<GitLogPage>();
    vi.mocked(gitService.getLog).mockImplementation((_path, query) =>
      query.branch === "feature" ? feature.promise : main.promise,
    );
    render(<GitTimelinePanel open onOpenChange={() => {}} projectPath="/repo" initialFile={null} />);

    const branch = await screen.findByRole("combobox", { name: /gitTimeline.branch|分支|Branch/i });
    await waitFor(() => expect(gitService.getLog).toHaveBeenCalledWith("/repo", expect.objectContaining({ branch: "main" })));
    fireEvent.change(branch, { target: { value: "feature" } });
    await waitFor(() => expect(gitService.getLog).toHaveBeenCalledWith("/repo", expect.objectContaining({ branch: "feature" })));

    await act(async () => feature.resolve(page("feature subject", "2222222222222222222222222222222222222222")));
    expect(await screen.findByText("feature subject")).toBeVisible();
    await act(async () => main.resolve(page("stale main subject", "1111111111111111111111111111111111111111")));
    expect(screen.queryByText("stale main subject")).not.toBeInTheDocument();
    expect(screen.getByText("feature subject")).toBeVisible();
  });

  it("WorktreeVsHead 入口明确标注内容对比并请求结构化文件", async () => {
    vi.mocked(gitService.getLog).mockResolvedValue(page("initial", "1111111111111111111111111111111111111111"));
    render(<GitTimelinePanel open onOpenChange={() => {}} projectPath="/repo" initialFile={changedFile} />);

    expect(await screen.findByText(/内容对比|Content comparison/i)).toBeVisible();
    await waitFor(() => expect(gitService.getDiff).toHaveBeenCalledWith("/repo", {
      mode: "worktreeVsHead",
      file: changedFile,
    }));
  });

  it("merge 默认 first parent 并可切换其他 parent", async () => {
    const mergePage = page("merge commit", "3333333333333333333333333333333333333333");
    mergePage.commits[0].parents = [
      "1111111111111111111111111111111111111111",
      "2222222222222222222222222222222222222222",
    ];
    vi.mocked(gitService.getLog).mockResolvedValue(mergePage);
    render(<GitTimelinePanel open onOpenChange={() => {}} projectPath="/repo" initialFile={null} />);

    fireEvent.click(await screen.findByText("merge commit"));
    await waitFor(() => expect(gitService.listCommitFiles).toHaveBeenCalledWith(
      "/repo",
      mergePage.commits[0].hash,
      0,
    ));
    fireEvent.change(screen.getByRole("combobox", { name: /对比父提交|Compare parent/i }), {
      target: { value: "1" },
    });
    await waitFor(() => expect(gitService.listCommitFiles).toHaveBeenCalledWith(
      "/repo",
      mergePage.commits[0].hash,
      1,
    ));
  });

  it("文件切换后丢弃较晚失败的旧 diff 响应", async () => {
    const oldDiff = deferred<Awaited<ReturnType<typeof gitService.getDiff>>>();
    const newDiff = deferred<Awaited<ReturnType<typeof gitService.getDiff>>>();
    const secondFile = { ...changedFile, oldPath: "src/b.ts", newPath: "src/b.ts" };
    vi.mocked(gitService.getLog).mockResolvedValue(page("initial", "1111111111111111111111111111111111111111"));
    vi.mocked(gitService.getDiff).mockImplementation((_path, spec) =>
      spec.file.newPath === "src/b.ts" ? newDiff.promise : oldDiff.promise,
    );
    const { rerender } = render(
      <GitTimelinePanel open onOpenChange={() => {}} projectPath="/repo" initialFile={changedFile} />,
    );
    await waitFor(() => expect(gitService.getDiff).toHaveBeenCalledWith(
      "/repo",
      { mode: "worktreeVsHead", file: changedFile },
    ));

    rerender(<GitTimelinePanel open onOpenChange={() => {}} projectPath="/repo" initialFile={secondFile} />);
    await waitFor(() => expect(gitService.getDiff).toHaveBeenCalledWith(
      "/repo",
      { mode: "worktreeVsHead", file: secondFile },
    ));
    await act(async () => newDiff.resolve({
      hunks: [],
      stats: { additions: 0, deletions: 0, changes: 0 },
      isBinary: false,
      truncated: false,
      truncationReason: null,
      oldSize: 1,
      newSize: 1,
    }));
    expect(await screen.findByText(/文件内容没有变更|No changes in file content/i)).toBeVisible();
    await act(async () => oldDiff.reject(new Error("stale diff error")));
    expect(screen.queryByText("stale diff error")).not.toBeInTheDocument();
  });
});

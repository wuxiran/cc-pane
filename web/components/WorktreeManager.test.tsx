import "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WorktreeManager from "./WorktreeManager";
import { worktreeService, type WorktreeInfo } from "@/services";
import { providerService } from "@/services/providerService";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("@/services", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services")>();
  return {
    ...actual,
    worktreeService: {
      list: vi.fn(),
      add: vi.fn(),
      remove: vi.fn(),
      isGitRepo: vi.fn(),
    },
  };
});

vi.mock("@/services/providerService", () => ({
  providerService: {
    openPathInExplorer: vi.fn(() => Promise.resolve()),
  },
}));

const PROJECT = "/home/user/repo";

function wt(overrides: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return { path: "/home/user/repo", branch: "main", commit: "abc1234", isMain: true, ...overrides };
}

function renderManager(props: Partial<React.ComponentProps<typeof WorktreeManager>> = {}) {
  const onOpenChange = vi.fn();
  const onOpenWorktree = vi.fn();
  render(
    <WorktreeManager
      open
      onOpenChange={onOpenChange}
      projectPath={PROJECT}
      onOpenWorktree={onOpenWorktree}
      {...props}
    />,
  );
  return { onOpenChange, onOpenWorktree };
}

describe("WorktreeManager", () => {
  beforeEach(() => {
    vi.mocked(worktreeService.list).mockReset().mockResolvedValue([]);
    vi.mocked(worktreeService.add).mockReset().mockResolvedValue("/home/user/repo-feat");
    vi.mocked(worktreeService.remove).mockReset().mockResolvedValue(undefined);
    vi.mocked(providerService.openPathInExplorer).mockClear();
  });

  it("关闭时不加载 worktree", () => {
    render(
      <WorktreeManager open={false} onOpenChange={vi.fn()} projectPath={PROJECT} onOpenWorktree={vi.fn()} />,
    );
    expect(worktreeService.list).not.toHaveBeenCalled();
  });

  it("打开时加载并展示 worktree 列表（含主标记）", async () => {
    vi.mocked(worktreeService.list).mockResolvedValue([
      wt(),
      wt({ path: "/home/user/repo-feat", branch: "feature", commit: "def5678", isMain: false }),
    ]);
    renderManager();

    expect(await screen.findByText("feature")).toBeInTheDocument();
    expect(screen.getByText("/home/user/repo-feat")).toBeInTheDocument();
    // 主 worktree 带徽标
    expect(screen.getByText(/^主$|^Main$/)).toBeInTheDocument();
    expect(worktreeService.list).toHaveBeenCalledWith(PROJECT);
  });

  it("列表为空时显示占位文案", async () => {
    vi.mocked(worktreeService.list).mockResolvedValue([]);
    renderManager();
    expect(await screen.findByText(/暂无 Worktree|No worktrees/i)).toBeInTheDocument();
  });

  it("填写名称后创建 worktree（无分支）", async () => {
    const user = userEvent.setup();
    renderManager();
    await screen.findByText(/暂无 Worktree|No worktrees/i);

    await user.type(screen.getByPlaceholderText(/名称|Name/i), "feat-x");
    await user.click(screen.getByRole("button", { name: /创建|Create/i }));

    await waitFor(() =>
      expect(worktreeService.add).toHaveBeenCalledWith(PROJECT, "feat-x", undefined),
    );
    // 创建后重新加载
    expect(worktreeService.list).toHaveBeenCalledTimes(2);
  });

  it("指定分支时创建 worktree 携带分支参数", async () => {
    const user = userEvent.setup();
    renderManager();
    await screen.findByText(/暂无 Worktree|No worktrees/i);

    const inputs = screen.getAllByRole("textbox");
    await user.type(inputs[0], "feat-y");
    await user.type(inputs[1], "custom-branch");
    await user.click(screen.getByRole("button", { name: /创建|Create/i }));

    await waitFor(() =>
      expect(worktreeService.add).toHaveBeenCalledWith(PROJECT, "feat-y", "custom-branch"),
    );
  });

  it("删除非主 worktree 需二次确认后调用 remove", async () => {
    const user = userEvent.setup();
    vi.mocked(worktreeService.list).mockResolvedValue([
      wt(),
      wt({ path: "/home/user/repo-feat", branch: "feature", isMain: false }),
    ]);
    renderManager();
    await screen.findByText("feature");

    await user.click(screen.getByRole("button", { name: /删除|Delete/i }));

    // 确认弹窗
    const confirmBtn = await screen.findByRole("button", { name: /^确定$|^Confirm$/ });
    await user.click(confirmBtn);

    await waitFor(() =>
      expect(worktreeService.remove).toHaveBeenCalledWith(PROJECT, "/home/user/repo-feat"),
    );
  });

  // 堵源头：worktree 被删后必须同步移除工作空间里的项目记录，否则孤儿项目只增不减
  it("删除成功后回调 onWorktreeRemoved 并通知列表变化", async () => {
    const user = userEvent.setup();
    vi.mocked(worktreeService.list).mockResolvedValue([
      wt(),
      wt({ path: "/home/user/repo-feat", branch: "feature", isMain: false }),
    ]);
    const onWorktreeRemoved = vi.fn();
    const onWorktreesChanged = vi.fn();
    renderManager({ onWorktreeRemoved, onWorktreesChanged });
    await screen.findByText("feature");

    await user.click(screen.getByRole("button", { name: /删除|Delete/i }));
    await user.click(await screen.findByRole("button", { name: /^确定$|^Confirm$/ }));

    await waitFor(() =>
      expect(onWorktreeRemoved).toHaveBeenCalledWith("/home/user/repo-feat"),
    );
    expect(onWorktreesChanged).toHaveBeenCalled();
  });

  // git 那一步已经成功了，联动失败不能让删除动作看起来失败
  it("联动回调抛错不阻断列表刷新", async () => {
    const user = userEvent.setup();
    vi.mocked(worktreeService.list).mockResolvedValue([
      wt(),
      wt({ path: "/home/user/repo-feat", branch: "feature", isMain: false }),
    ]);
    const onWorktreeRemoved = vi.fn().mockRejectedValue(new Error("boom"));
    renderManager({ onWorktreeRemoved });
    await screen.findByText("feature");

    await user.click(screen.getByRole("button", { name: /删除|Delete/i }));
    await user.click(await screen.findByRole("button", { name: /^确定$|^Confirm$/ }));

    // 首次挂载 1 次 + 删除后刷新 1 次
    await waitFor(() => expect(worktreeService.list).toHaveBeenCalledTimes(2));
  });

  it("点击终端按钮触发 onOpenWorktree 回调", async () => {
    const user = userEvent.setup();
    vi.mocked(worktreeService.list).mockResolvedValue([wt()]);
    const { onOpenWorktree } = renderManager();
    await screen.findByText(/^主$|^Main$/);

    await user.click(screen.getByRole("button", { name: /在此目录打开|Open here/i }));
    expect(onOpenWorktree).toHaveBeenCalledWith("/home/user/repo");
  });

  it("点击文件夹按钮在资源管理器中打开路径", async () => {
    const user = userEvent.setup();
    vi.mocked(worktreeService.list).mockResolvedValue([wt()]);
    renderManager();
    await screen.findByText(/^主$|^Main$/);

    await user.click(screen.getByRole("button", { name: /在系统文件管理器中打开|Open .* file/i }));
    await waitFor(() =>
      expect(providerService.openPathInExplorer).toHaveBeenCalledWith("/home/user/repo"),
    );
  });
});

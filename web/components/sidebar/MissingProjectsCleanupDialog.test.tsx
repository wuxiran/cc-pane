import "@/i18n";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MissingProjectsCleanupDialog from "./MissingProjectsCleanupDialog";
import {
  createTestWorkspace,
  createTestWorkspaceProject,
  resetTestDataCounter,
} from "@/test/utils/testData";
import type { ProjectPathStatus } from "@/types";

describe("MissingProjectsCleanupDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTestDataCounter();
  });

  function setup(onConfirm = vi.fn()) {
    const gone = createTestWorkspaceProject({ alias: "gone", path: "D:\\gone" });
    const unknown = createTestWorkspaceProject({ alias: "unknown", path: "D:\\unknown" });
    const alive = createTestWorkspaceProject({ alias: "alive", path: "D:\\alive" });
    const workspace = createTestWorkspace({ projects: [gone, unknown, alive] });
    const statuses: ProjectPathStatus[] = [
      { projectId: gone.id, path: gone.path, status: "missing" },
      { projectId: unknown.id, path: unknown.path, status: "unverifiable" },
      { projectId: alive.id, path: alive.path, status: "present" },
    ];

    render(
      <MissingProjectsCleanupDialog
        open
        setOpen={vi.fn()}
        workspace={workspace}
        statuses={statuses}
        onConfirm={onConfirm}
      />
    );
    return { gone, unknown, alive, onConfirm };
  }

  it("只列出 missing 与 unverifiable，正常项目不出现", () => {
    setup();

    expect(screen.getByText("gone")).toBeInTheDocument();
    expect(screen.getByText("unknown")).toBeInTheDocument();
    expect(screen.queryByText("alive")).not.toBeInTheDocument();
  });

  // 非破坏性默认：无法验证的项目默认不勾选，避免 WSL 未运行时误删有效注册
  it("missing 默认全选，unverifiable 默认不选", () => {
    setup();

    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes).toHaveLength(2);
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].checked).toBe(false);
  });

  it("确认只提交被勾选的项目 id", async () => {
    const user = userEvent.setup();
    const { gone, unknown, onConfirm } = setup();

    await user.click(screen.getAllByRole("checkbox")[1]);
    await user.click(screen.getByRole("button", { name: /移除 2 条记录/ }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(new Set(onConfirm.mock.calls[0][0])).toEqual(new Set([gone.id, unknown.id]));
  });

  it("取消勾选后不提交该项目", async () => {
    const user = userEvent.setup();
    const { unknown, onConfirm } = setup();

    await user.click(screen.getAllByRole("checkbox")[0]);
    await user.click(screen.getAllByRole("checkbox")[1]);
    await user.click(screen.getByRole("button", { name: /移除 1 条记录/ }));

    expect(onConfirm).toHaveBeenCalledWith([unknown.id]);
  });

  it("一个都没勾选时确认按钮禁用", async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getAllByRole("checkbox")[0]);
    expect(screen.getByRole("button", { name: /移除 0 条记录/ })).toBeDisabled();
  });

  it("描述文案明确声明不删除磁盘文件", () => {
    setup();
    expect(screen.getByText(/不会删除磁盘上的任何文件/)).toBeInTheDocument();
  });

  it("没有失效项目时显示空态", () => {
    const workspace = createTestWorkspace({ projects: [] });
    render(
      <MissingProjectsCleanupDialog
        open
        setOpen={vi.fn()}
        workspace={workspace}
        statuses={[]}
        onConfirm={vi.fn()}
      />
    );
    expect(screen.getByText("没有失效项目")).toBeInTheDocument();
  });
});

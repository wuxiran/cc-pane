import "@/i18n";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { toastErr, toastOk } from "@/lib/feedback";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GitCloneDialog from "./GitCloneDialog";

vi.mock("@/lib/feedback", () => ({
  toastOk: vi.fn(),
  toastInfo: vi.fn(),
  toastErr: vi.fn(),
}));

interface RenderOpts {
  workspaceName?: string;
  onCloned?: (path: string) => void;
  onOpenChange?: (open: boolean) => void;
}

function renderDialog(opts: RenderOpts = {}) {
  const onCloned = opts.onCloned ?? vi.fn();
  const onOpenChange = opts.onOpenChange ?? vi.fn();
  render(
    <GitCloneDialog
      open
      onOpenChange={onOpenChange}
      workspaceName={opts.workspaceName ?? "MyWorkspace"}
      onCloned={onCloned}
    />,
  );
  return { onCloned, onOpenChange };
}

/** 根据占位符定位三个主要输入框 */
function inputs() {
  return {
    url: screen.getByPlaceholderText("https://github.com/user/repo.git") as HTMLInputElement,
    parentDir: screen.getByPlaceholderText(/选择父目录|Select/i) as HTMLInputElement,
    folderName: screen.getByPlaceholderText(/从 URL 自动推导|derive/i) as HTMLInputElement,
  };
}

function cloneButton() {
  return screen.getByRole("button", { name: /^克隆$|^Clone$|克隆中|Cloning/i });
}

describe("GitCloneDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("open=false 时不渲染标题", () => {
    render(
      <GitCloneDialog
        open={false}
        onOpenChange={vi.fn()}
        workspaceName="MyWorkspace"
        onCloned={vi.fn()}
      />,
    );
    expect(screen.queryByText(/克隆到|Clone to/i)).not.toBeInTheDocument();
  });

  it("open=true 渲染标题并带上工作空间名", () => {
    renderDialog({ workspaceName: "MyWorkspace" });
    expect(screen.getByText(/MyWorkspace/)).toBeInTheDocument();
    // 标题文案：克隆到「name」 / Clone to "name"（与「克隆到目录」标签区分）
    expect(screen.getByText(/克隆到「|Clone to "/i)).toBeInTheDocument();
  });

  it("输入 URL 后自动推导项目文件夹名", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(inputs().url, "https://github.com/user/repo.git");
    await waitFor(() => expect(inputs().folderName.value).toBe("repo"));
  });

  it("手动修改文件夹名后不再被 URL 覆盖", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(inputs().folderName, "custom-name");
    await user.type(inputs().url, "https://github.com/user/repo.git");
    // 手动输入优先，folderName 不被自动推导覆盖
    await waitFor(() => expect(inputs().url.value).toContain("repo.git"));
    expect(inputs().folderName.value).toBe("custom-name");
  });

  it("必填项未填时克隆按钮禁用，填完后启用", async () => {
    const user = userEvent.setup();
    renderDialog();
    expect(cloneButton()).toBeDisabled();

    await user.type(inputs().url, "https://github.com/user/repo.git");
    await user.type(inputs().parentDir, "C:/repos");
    await waitFor(() => expect(cloneButton()).toBeEnabled());
  });

  it("成功克隆：以正确参数调用 git_clone 并回调", async () => {
    const user = userEvent.setup();
    vi.mocked(invoke).mockResolvedValue("C:/repos/repo");
    const { onCloned, onOpenChange } = renderDialog();

    await user.type(inputs().url, "https://github.com/user/repo.git");
    await user.type(inputs().parentDir, "C:/repos");
    await waitFor(() => expect(inputs().folderName.value).toBe("repo"));

    await user.click(cloneButton());

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("git_clone", {
        request: {
          url: "https://github.com/user/repo.git",
          targetDir: "C:/repos",
          folderName: "repo",
          shallow: false,
          username: undefined,
          password: undefined,
        },
      }),
    );
    expect(toastOk).toHaveBeenCalled();
    expect(onCloned).toHaveBeenCalledWith("C:/repos/repo");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("勾选浅克隆后请求参数 shallow=true", async () => {
    const user = userEvent.setup();
    vi.mocked(invoke).mockResolvedValue("C:/repos/repo");
    renderDialog();

    await user.type(inputs().url, "https://github.com/user/repo.git");
    await user.type(inputs().parentDir, "C:/repos");
    await waitFor(() => expect(inputs().folderName.value).toBe("repo"));
    await user.click(screen.getByText(/浅克隆|Shallow/i));

    await user.click(cloneButton());

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "git_clone",
        expect.objectContaining({ request: expect.objectContaining({ shallow: true }) }),
      ),
    );
  });

  it("克隆失败时提示错误且不回调 onCloned", async () => {
    const user = userEvent.setup();
    vi.mocked(invoke).mockRejectedValue(new Error("network down"));
    const { onCloned, onOpenChange } = renderDialog();

    await user.type(inputs().url, "https://github.com/user/repo.git");
    await user.type(inputs().parentDir, "C:/repos");
    await waitFor(() => expect(inputs().folderName.value).toBe("repo"));

    await user.click(cloneButton());

    await waitFor(() => expect(toastErr).toHaveBeenCalled());
    expect(onCloned).not.toHaveBeenCalled();
    // 失败路径不会关闭对话框
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("点击选目录按钮调用系统对话框并写入目标目录", async () => {
    const user = userEvent.setup();
    vi.mocked(open).mockResolvedValue("C:/selected/dir");
    renderDialog();

    const dirRow = inputs().parentDir.parentElement as HTMLElement;
    await user.click(within(dirRow).getByRole("button"));

    await waitFor(() => expect(open).toHaveBeenCalled());
    await waitFor(() => expect(inputs().parentDir.value).toBe("C:/selected/dir"));
  });

  it("点击取消按钮触发 onOpenChange(false)", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    await user.click(screen.getByRole("button", { name: /取消|Cancel/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

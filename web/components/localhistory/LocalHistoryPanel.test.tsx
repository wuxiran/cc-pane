import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LocalHistoryPanel from "./LocalHistoryPanel";
import { mockTauriInvoke, resetTauriInvoke } from "@/test/utils/mockTauriInvoke";
import type { DiffResult, FileVersion, RecentChange } from "@/services";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

const PROJECT = "C:/proj";
const FILE = "src/app.ts";

const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

// 服务层返回时间从旧到新；组件内部会 reverse 成 newest-first
const V_OLD: FileVersion = {
  id: "v-old",
  filePath: FILE,
  hash: "h1",
  size: 100,
  createdAt: iso(10 * 60 * 1000), // 10 分钟前
  isDeleted: false,
  branch: "",
};
const V_NEW: FileVersion = {
  id: "v-new",
  filePath: FILE,
  hash: "h2",
  size: 200,
  createdAt: iso(0), // 刚刚
  isDeleted: false,
  branch: "",
};

const DIFF: DiffResult = {
  hunks: [
    {
      oldStart: 1,
      oldCount: 1,
      newStart: 1,
      newCount: 2,
      lines: [
        { changeType: "insert", content: "added line", oldLineNo: null, newLineNo: 2, inlineChanges: null },
      ],
    },
  ],
  stats: { additions: 3, deletions: 1, changes: 0 },
  isBinary: false,
  truncated: false,
};

/** 默认所有命令都有安全返回值，避免 mockTauriInvoke 对未处理命令 reject */
function setup(overrides: Record<string, unknown> = {}) {
  mockTauriInvoke({
    get_recent_changes: [],
    list_file_versions: [V_OLD, V_NEW],
    list_labels: [],
    get_file_branches: [],
    get_versions_diff: DIFF,
    get_version_diff: DIFF,
    get_version_content: "hello content",
    restore_file_version: null,
    list_deleted_files: [],
    restore_to_label: [],
    put_label: null,
    ...overrides,
  });
}

describe("LocalHistoryPanel", () => {
  beforeEach(() => {
    resetTauriInvoke();
  });

  it("open 为 false 时不渲染对话框", () => {
    setup();
    render(<LocalHistoryPanel open={false} onOpenChange={vi.fn()} projectPath={PROJECT} filePath={FILE} />);
    expect(screen.queryByText(/文件历史|File History/i)).not.toBeInTheDocument();
  });

  it("filePath 模式下加载版本列表并展示工具栏与空预览占位", async () => {
    setup();
    render(<LocalHistoryPanel open onOpenChange={vi.fn()} projectPath={PROJECT} filePath={FILE} />);

    // 工具栏按钮
    expect(await screen.findByRole("button", { name: /差异|Diff/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /完整内容|Full Content/i })).toBeInTheDocument();

    // 版本行（相对时间）
    expect(await screen.findByText("刚刚")).toBeInTheDocument();
    expect(screen.getByText("10 分钟前")).toBeInTheDocument();

    // 未选中版本 → 预览占位
    expect(screen.getByText(/选择一个版本查看内容|Select a version/i)).toBeInTheDocument();

    expect(invoke).toHaveBeenCalledWith("list_file_versions", { projectPath: PROJECT, filePath: FILE });
  });

  it("版本列表为空时展示无历史提示", async () => {
    setup({ list_file_versions: [] });
    render(<LocalHistoryPanel open onOpenChange={vi.fn()} projectPath={PROJECT} filePath={FILE} />);
    expect(await screen.findByText(/暂无历史版本|No history/i)).toBeInTheDocument();
  });

  it("选中较新版本时与前一版本比较，调用 get_versions_diff 并渲染 diff 统计", async () => {
    const user = userEvent.setup();
    setup();
    render(<LocalHistoryPanel open onOpenChange={vi.fn()} projectPath={PROJECT} filePath={FILE} />);

    await user.click(await screen.findByText("刚刚"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("get_versions_diff", {
        projectPath: PROJECT,
        filePath: FILE,
        oldVersionId: "v-old",
        newVersionId: "v-new",
      }),
    );
    // DiffView 渲染统计
    expect(await screen.findByText("+3")).toBeInTheDocument();
    // diff 描述：旧 → 新
    expect(screen.getByText(/10 分钟前 →/)).toBeInTheDocument();
  });

  it("选中最早版本时回退为与当前磁盘文件比较（get_version_diff）", async () => {
    const user = userEvent.setup();
    setup();
    render(<LocalHistoryPanel open onOpenChange={vi.fn()} projectPath={PROJECT} filePath={FILE} />);

    await user.click(await screen.findByText("10 分钟前"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("get_version_diff", {
        projectPath: PROJECT,
        filePath: FILE,
        versionId: "v-old",
      }),
    );
    expect(await screen.findByText(/最早版本|earliest/i)).toBeInTheDocument();
  });

  it("完整内容模式下选中版本会加载并展示版本内容", async () => {
    const user = userEvent.setup();
    setup();
    render(<LocalHistoryPanel open onOpenChange={vi.fn()} projectPath={PROJECT} filePath={FILE} />);

    await user.click(await screen.findByRole("button", { name: /完整内容|Full Content/i }));
    await user.click(await screen.findByText("刚刚"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("get_version_content", {
        projectPath: PROJECT,
        filePath: FILE,
        versionId: "v-new",
      }),
    );
    expect(await screen.findByText("hello content")).toBeInTheDocument();
  });

  it("恢复版本时调用 restore_file_version，并触发 onRestored 与关闭", async () => {
    const user = userEvent.setup();
    const onRestored = vi.fn();
    const onOpenChange = vi.fn();
    setup();
    render(
      <LocalHistoryPanel
        open
        onOpenChange={onOpenChange}
        projectPath={PROJECT}
        filePath={FILE}
        onRestored={onRestored}
      />,
    );

    await user.click(await screen.findByText("刚刚"));
    await user.click(await screen.findByRole("button", { name: /恢复此版本|Restore this version/i }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("restore_file_version", {
        projectPath: PROJECT,
        filePath: FILE,
        versionId: "v-new",
      }),
    );
    expect(onRestored).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("右键版本可打开添加标签对话框并提交标签（put_label）", async () => {
    const user = userEvent.setup();
    setup();
    render(<LocalHistoryPanel open onOpenChange={vi.fn()} projectPath={PROJECT} filePath={FILE} />);

    fireEvent.contextMenu(await screen.findByText("刚刚"));

    const input = await screen.findByPlaceholderText(/标签名称|Tag name/i);
    await user.type(input, "发布前");
    await user.click(screen.getByRole("button", { name: /^确定$|^Confirm$/i }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "put_label",
        expect.objectContaining({
          projectPath: PROJECT,
          label: expect.objectContaining({ name: "发布前" }),
        }),
      ),
    );
  });

  it("切换到已删除视图时加载并展示已删除文件", async () => {
    const user = userEvent.setup();
    const deleted: FileVersion = { ...V_OLD, id: "d1", filePath: "src/gone.ts", isDeleted: true };
    setup({ list_deleted_files: [deleted] });
    render(<LocalHistoryPanel open onOpenChange={vi.fn()} projectPath={PROJECT} filePath={FILE} />);

    await user.click(await screen.findByRole("button", { name: /已删除|Deleted/i }));

    expect(await screen.findByText("src/gone.ts")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("list_deleted_files", { projectPath: PROJECT });
  });

  it("切换到项目恢复视图且无标签时展示空快照提示", async () => {
    const user = userEvent.setup();
    setup({ list_labels: [] });
    render(<LocalHistoryPanel open onOpenChange={vi.fn()} projectPath={PROJECT} filePath={FILE} />);

    await user.click(await screen.findByRole("button", { name: /项目恢复|Project Restore/i }));

    expect(await screen.findByText(/暂无快照标签|No snapshot/i)).toBeInTheDocument();
  });

  it("未提供 filePath 时进入文件列表模式，点击文件进入版本视图", async () => {
    const user = userEvent.setup();
    const change: RecentChange = {
      filePath: "src/main.ts",
      versionId: "v-new",
      timestamp: iso(0),
      size: 300,
      hash: "h",
      labelName: null,
      branch: "",
    };
    setup({ get_recent_changes: [change] });
    render(<LocalHistoryPanel open onOpenChange={vi.fn()} projectPath={PROJECT} />);

    // getFileName("src/main.ts") → "main.ts"
    const fileRow = await screen.findByText("main.ts");
    await user.click(fileRow);

    // 进入版本视图后工具栏出现
    expect(await screen.findByRole("button", { name: /差异|Diff/i })).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("get_recent_changes", { projectPath: PROJECT, limit: 200 });
  });

  it("文件列表为空时展示无文件历史提示", async () => {
    setup({ get_recent_changes: [] });
    render(<LocalHistoryPanel open onOpenChange={vi.fn()} projectPath={PROJECT} />);
    expect(await screen.findByText(/暂无文件历史记录|No file history/i)).toBeInTheDocument();
  });
});

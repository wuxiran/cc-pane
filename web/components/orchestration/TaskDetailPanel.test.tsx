import "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskBinding } from "@/types";
import { useActivityBarStore, usePanesStore } from "@/stores";
import TaskDetailPanel from "./TaskDetailPanel";

function makeBinding(overrides?: Partial<TaskBinding>): TaskBinding {
  return {
    id: "binding-1",
    title: "Fix flaky tests",
    role: "worker",
    projectPath: "D:/proj",
    cliTool: "claude",
    status: "running",
    progress: 40,
    sortOrder: 0,
    createdAt: "2026-07-01T10:00:00Z",
    updatedAt: "2026-07-01T11:00:00Z",
    ...overrides,
  };
}

describe("TaskDetailPanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the empty placeholder when no binding is selected", () => {
    render(<TaskDetailPanel binding={null} />);

    expect(screen.getByText("未选择任务")).toBeInTheDocument();
    expect(screen.getByText("从编排列表中选择一个任务。")).toBeInTheDocument();
  });

  it("renders header info and session fields for a binding", () => {
    render(
      <TaskDetailPanel
        binding={makeBinding({
          sessionId: "sess-1",
          resumeId: "resume-1",
          paneId: "pane-1",
          tabId: "tab-1",
          workspaceName: "ws",
          completionSummary: "half done",
          exitCode: 0,
        })}
      />
    );

    expect(screen.getByRole("heading", { name: "Fix flaky tests" })).toBeInTheDocument();
    expect(screen.getByText("worker")).toBeInTheDocument();
    expect(screen.getByText("claude")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText("sess-1")).toBeInTheDocument();
    expect(screen.getByText("resume-1")).toBeInTheDocument();
    expect(screen.getByText("pane-1 / tab-1")).toBeInTheDocument();
    expect(screen.getByText("half done")).toBeInTheDocument();
  });

  it("keeps 'View in PTY' disabled without a session id", () => {
    render(<TaskDetailPanel binding={makeBinding()} />);

    expect(screen.getByRole("button", { name: /在终端中查看/ })).toBeDisabled();
  });

  it("activates the pane and tab of the bound session via View in PTY", async () => {
    const user = userEvent.setup();
    const rafSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb) => {
        cb(0);
        return 0;
      });
    const setAppViewMode = vi.fn();
    useActivityBarStore.setState({ setAppViewMode });

    const switchLayout = vi.fn();
    const setActivePane = vi.fn();
    const switchToTab = vi.fn();
    usePanesStore.setState({
      currentLayoutId: "layout-1",
      findTabBySessionAcrossLayouts: () => ({
        layoutId: "layout-2",
        panel: {
          type: "panel",
          id: "pane-9",
          tabs: [{ id: "tab-8" }, { id: "tab-9" }],
          activeTabId: "tab-8",
        },
        tab: { id: "tab-9" },
      }),
      switchLayout,
      setActivePane,
      switchToTab,
    } as never);

    render(<TaskDetailPanel binding={makeBinding({ sessionId: "sess-1" })} />);
    await user.click(screen.getByRole("button", { name: /在终端中查看/ }));

    expect(setAppViewMode).toHaveBeenCalledWith("panes");
    expect(switchLayout).toHaveBeenCalledWith("layout-2");
    expect(setActivePane).toHaveBeenCalledWith("pane-9");
    expect(switchToTab).toHaveBeenCalledWith("pane-9", 1);
    rafSpy.mockRestore();
  });

  it("collapses and expands the prompt content", async () => {
    const user = userEvent.setup();
    render(<TaskDetailPanel binding={makeBinding({ prompt: "do the thing" })} />);

    expect(screen.getByText("do the thing")).toBeInTheDocument();

    await user.click(screen.getByText("提示词内容"));
    expect(screen.queryByText("do the thing")).not.toBeInTheDocument();

    await user.click(screen.getByText("提示词内容"));
    expect(screen.getByText("do the thing")).toBeInTheDocument();
  });

  it("copies the prompt to the clipboard and shows transient feedback", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<TaskDetailPanel binding={makeBinding({ prompt: "copy me" })} />);
    await user.click(screen.getByRole("button", { name: "复制提示词" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("copy me"));
  });

  it("disables the copy button when there is no prompt", () => {
    render(<TaskDetailPanel binding={makeBinding()} />);

    expect(screen.getByText("未存储提示词")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制提示词" })).toBeDisabled();
  });

  it("renders timeline values from ui metadata over top-level metadata", () => {
    render(
      <TaskDetailPanel
        binding={makeBinding({
          metadata: {
            startedAt: "2026-07-01T10:05:00Z",
            ui: { completedAt: "2026-07-01T12:00:00Z" },
          },
        })}
      />
    );

    expect(screen.getByText("创建")).toBeInTheDocument();
    expect(screen.getByText("开始")).toBeInTheDocument();
    expect(screen.getByText("完成")).toBeInTheDocument();
    // ui.completedAt 与 metadata.startedAt 都被格式化为本地时间，不再是原始 ISO 字符串
    expect(screen.queryByText("2026-07-01T12:00:00Z")).not.toBeInTheDocument();
  });

  it("shows a metadata JSON tree and a no-metadata placeholder", () => {
    const { rerender } = render(
      <TaskDetailPanel binding={makeBinding({ metadata: { foo: "bar", items: [1, 2] } })} />
    );

    expect(screen.getByText("Object(2)")).toBeInTheDocument();
    expect(screen.getByText('"bar"')).toBeInTheDocument();

    rerender(<TaskDetailPanel binding={makeBinding({ metadata: null })} />);
    expect(screen.getByText("无元数据")).toBeInTheDocument();
  });

  it("keeps an unparseable date string as-is and dashes for missing values", () => {
    render(<TaskDetailPanel binding={makeBinding({ createdAt: "not-a-date" })} />);

    expect(screen.getByText("not-a-date")).toBeInTheDocument();
  });
});

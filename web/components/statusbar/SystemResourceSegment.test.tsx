import "@/i18n";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { systemStatsService } from "@/services/systemStatsService";
import { terminalService } from "@/services/terminalService";
import { usePanesStore, useTerminalStatusStore } from "@/stores";
import type { ResourceTree } from "@/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import SystemResourceSegment from "./SystemResourceSegment";

vi.mock("@/services/systemStatsService", () => ({
  systemStatsService: {
    get: vi.fn(),
    getResourceTree: vi.fn(),
    killOrphans: vi.fn(),
  },
}));

const stats = {
  cpuPercent: 12.4,
  memUsed: 18.2 * 1024 ** 3,
  memTotal: 64 * 1024 ** 3,
};

const tree: ResourceTree = {
  system: stats,
  appMemoryBytes: 512 * 1024 ** 2,
  appMemoryPercent: 0.8,
  sessions: [
    {
      sessionId: "session-1",
      rootPid: 20,
      cpuPercent: 7.5,
      memoryBytes: 256 * 1024 ** 2,
      processCount: 2,
    },
  ],
  orphans: [
    {
      pid: 42,
      name: "conhost.exe",
      command: "conhost.exe --headless",
      cpuPercent: 1.5,
      memoryBytes: 32 * 1024 ** 2,
      processCount: 2,
    },
  ],
  sampledAt: 123,
  elapsedMicros: 750,
};

function setDocumentHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: hidden,
  });
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function openPopover() {
  fireEvent.click(screen.getByRole("button", { name: /资源管理器|resource manager/i }));
  await flushPromises();
  expect(screen.getByText(/受管会话|managed sessions/i)).toBeVisible();
}

function renderSegment() {
  return render(
    <TooltipProvider>
      <SystemResourceSegment />
    </TooltipProvider>,
  );
}

describe("SystemResourceSegment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    setDocumentHidden(false);
    vi.mocked(systemStatsService.get).mockResolvedValue(stats);
    vi.mocked(systemStatsService.getResourceTree).mockResolvedValue(tree);
    vi.mocked(systemStatsService.killOrphans).mockResolvedValue([
      { pid: 42, success: true, error: null },
    ]);
    vi.spyOn(terminalService, "killSession").mockResolvedValue();
    useTerminalStatusStore.setState({
      statusMap: new Map([
        [
          "session-1",
          {
            sessionId: "session-1",
            status: "thinking",
            lastOutputAt: 1,
            updatedAt: 1,
          },
        ],
      ]),
    });

    const panes = usePanesStore.getState();
    vi.spyOn(panes, "findTabBySessionAcrossLayouts").mockReturnValue({
      layoutId: "layout-other",
      layoutName: "Other layout",
      tree: { type: "panel", id: "pane-1", activeTabId: "tab-1", tabs: [] },
      panel: { type: "panel", id: "pane-1", activeTabId: "tab-1", tabs: [] },
      tab: {
        id: "tab-1",
        title: "Codex tab",
        contentType: "terminal",
        projectId: "project-1",
        projectPath: "D:/work/project-1",
        sessionId: "session-1",
        workspaceName: "Workspace A",
        cliTool: "codex",
      },
    } as never);
    vi.spyOn(panes, "switchLayout").mockImplementation(() => {});
    vi.spyOn(panes, "setActivePane").mockImplementation(() => {});
    vi.spyOn(panes, "selectTab").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    setDocumentHidden(false);
  });

  it("渲染 CPU 与内存用量，并每 3 秒拉取轻量系统统计", async () => {
    renderSegment();
    await flushPromises();

    expect(screen.getByText("12%")).toBeInTheDocument();
    expect(screen.getByText("18.2/64G")).toBeInTheDocument();
    expect(systemStatsService.get).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(systemStatsService.get).toHaveBeenCalledTimes(2);
    expect(systemStatsService.getResourceTree).not.toHaveBeenCalled();
  });

  it("弹层打开时立即枚举且每 3 秒刷新，关闭后停止枚举", async () => {
    renderSegment();
    await flushPromises();

    await openPopover();
    expect(systemStatsService.getResourceTree).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(systemStatsService.getResourceTree).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: /资源管理器|resource manager/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(systemStatsService.getResourceTree).toHaveBeenCalledTimes(2);
  });

  it("手动刷新资源树", async () => {
    renderSegment();
    await flushPromises();
    await openPopover();

    fireEvent.click(screen.getByRole("button", { name: /刷新资源|refresh resources/i }));
    await flushPromises();
    expect(systemStatsService.getResourceTree).toHaveBeenCalledTimes(2);
  });

  it("点击会话行跳转并聚焦对应终端 tab", async () => {
    renderSegment();
    await flushPromises();
    await openPopover();

    fireEvent.click(screen.getByRole("button", { name: /聚焦会话: Codex tab|focus session: Codex tab/i }));
    const panes = usePanesStore.getState();
    expect(panes.switchLayout).toHaveBeenCalledWith("layout-other");
    expect(panes.setActivePane).toHaveBeenCalledWith("pane-1");
    expect(panes.selectTab).toHaveBeenCalledWith("pane-1", "tab-1");
  });

  it("会话结束必须经过行内二次确认并走 killSession", async () => {
    renderSegment();
    await flushPromises();
    await openPopover();

    fireEvent.click(screen.getByRole("button", { name: /结束会话.*Codex tab|end session.*Codex tab/i }));
    fireEvent.click(screen.getByRole("button", { name: /确认结束|confirm end/i }));
    await flushPromises();

    expect(terminalService.killSession).toHaveBeenCalledWith("session-1", "user-close");
  });

  it("用琥珀语义显示孤立计数并在列出明细后二次确认批量终止", async () => {
    renderSegment();
    await flushPromises();
    await openPopover();

    const count = screen.getByText(/1 个孤立项|1 orphaned item/i);
    expect(count).toHaveStyle({ color: "var(--app-status-warning)" });
    fireEvent.click(screen.getByRole("button", { name: /展开孤立进程|expand orphaned processes/i }));
    expect(screen.getByText("conhost.exe")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /终止 1 个孤立进程|terminate 1 orphaned process/i }));
    fireEvent.click(screen.getByRole("button", { name: /确认终止 1 个孤立进程|confirm termination of 1 orphaned process/i }));
    await flushPromises();

    expect(systemStatsService.killOrphans).toHaveBeenCalledWith([42]);
  });
});

import "@/i18n";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getVersion } from "@tauri-apps/api/app";
import packageJson from "../../../package.json";
import { historyService } from "@/services/historyService";
import { isTauriRuntime } from "@/services/runtime";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useDialogStore } from "@/stores";
import { useWorkspacesStore } from "@/stores/useWorkspacesStore";
import type { LaunchRecord } from "@/services";
import type { Workspace } from "@/types";
import HomeDashboard from "./HomeDashboard";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(),
}));

vi.mock("@/services/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/runtime")>();
  return { ...actual, isTauriRuntime: vi.fn(() => false) };
});

// 子组件均有独立测试，这里桩化以聚焦 Dashboard 的编排逻辑
vi.mock("./HomeHeader", () => ({
  default: ({ version }: { version: string }) => (
    <div data-testid="header">{version}</div>
  ),
}));
vi.mock("./HomeQuickActions", () => ({
  default: ({ onNewTerminal }: { onNewTerminal: () => void }) => (
    <button data-testid="quick-actions" onClick={onNewTerminal} />
  ),
}));
vi.mock("./HomeRecentProjects", () => ({
  default: ({ records }: { records: LaunchRecord[] }) => (
    <div data-testid="recent">{records.length}</div>
  ),
}));
vi.mock("./HomeActiveSessions", () => ({ default: () => null }));
vi.mock("./HomeEnvironment", () => ({ default: () => null }));
vi.mock("./HomeUsageStats", () => ({
  default: () => <div data-testid="usage-stats" />,
}));
vi.mock("./HomeShortcuts", () => ({ default: () => null }));
vi.mock("./HomeGettingStarted", () => ({
  default: () => <div data-testid="getting-started" />,
}));
vi.mock("./HomeDesignHighlights", () => ({
  default: ({ compact }: { compact?: boolean }) => (
    <div data-testid={compact ? "highlights-compact" : "highlights-card"} />
  ),
}));

const RECORD = { id: 1 } as unknown as LaunchRecord;

function makeWorkspace(projectCount: number): Workspace {
  return {
    id: `ws-${projectCount}`,
    name: `ws-${projectCount}`,
    projects: Array.from({ length: projectCount }, (_, i) => ({
      id: `p-${i}`,
      path: `D:/proj-${i}`,
    })),
  } as unknown as Workspace;
}

describe("HomeDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isTauriRuntime).mockReturnValue(false);
    vi.spyOn(historyService, "list").mockResolvedValue([RECORD]);
    useActivityBarStore.setState({ appViewMode: "home" });
    useWorkspacesStore.setState({
      workspaces: [makeWorkspace(1)],
      load: vi.fn(async () => {}),
    });
  });

  it("非 Tauri 环境使用 package.json 版本并加载启动历史", async () => {
    render(<HomeDashboard onOpenTerminal={vi.fn()} />);

    expect(await screen.findByText(packageJson.version)).toBeInTheDocument();
    expect(historyService.list).toHaveBeenCalledWith(20);
    expect((await screen.findByTestId("recent")).textContent).toBe("1");
  });

  it("Tauri 环境从 getVersion 取版本号", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    vi.mocked(getVersion).mockResolvedValue("9.9.9");
    render(<HomeDashboard onOpenTerminal={vi.fn()} />);

    expect(await screen.findByText("9.9.9")).toBeInTheDocument();
    expect(historyService.list).toHaveBeenCalledWith(20);
  });

  it("getVersion 失败时保留占位版本但仍加载历史", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    vi.mocked(getVersion).mockRejectedValue(new Error("no ipc"));
    render(<HomeDashboard onOpenTerminal={vi.fn()} />);

    expect((await screen.findByTestId("recent")).textContent).toBe("1");
    expect(screen.getByTestId("header").textContent).toBe("...");
  });

  it("history-updated 事件触发重新加载历史", async () => {
    render(<HomeDashboard onOpenTerminal={vi.fn()} />);
    await screen.findByTestId("recent");
    expect(historyService.list).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event("cc-panes:history-updated"));
    });

    expect(historyService.list).toHaveBeenCalledTimes(2);
  });

  it("点击进入工作区切换到 panes 视图并展开左侧面板", async () => {
    useActivityBarStore.setState({ appViewMode: "home", sidebarVisible: false });
    render(<HomeDashboard onOpenTerminal={vi.fn()} />);
    await screen.findByTestId("recent");

    fireEvent.click(screen.getByRole("button", { name: /进入工作区/ }));

    expect(useActivityBarStore.getState().appViewMode).toBe("panes");
    expect(useActivityBarStore.getState().sidebarVisible).toBe(true);
  });

  it("进入工作区按钮只有一份，且与问候区同处顶部区块", async () => {
    render(<HomeDashboard onOpenTerminal={vi.fn()} />);
    await screen.findByTestId("recent");

    const buttons = screen.getAllByRole("button", { name: /进入工作区/ });
    expect(buttons).toHaveLength(1);

    // 原先按钮独占页面最底部的容器；现在应与问候区（HomeHeader 桩）同属一个区块
    expect(buttons[0].parentElement?.contains(screen.getByTestId("header"))).toBe(true);
  });

  it("快速操作的新建终端回调打开启动器", async () => {
    render(<HomeDashboard onOpenTerminal={vi.fn()} />);
    await screen.findByTestId("recent");

    fireEvent.click(screen.getByTestId("quick-actions"));

    // 新建终端已改为打开全局启动器（LauncherDialog），不再直接切 panes 视图
    expect(useDialogStore.getState().launcherOpen).toBe(true);
  });

  it("老用户（有项目）显示用量趋势 + 页脚紧凑理念条，不显示引导卡", async () => {
    render(<HomeDashboard onOpenTerminal={vi.fn()} />);
    await screen.findByTestId("recent");

    expect(screen.getByTestId("usage-stats")).toBeInTheDocument();
    expect(screen.getByTestId("highlights-compact")).toBeInTheDocument();
    expect(screen.queryByTestId("getting-started")).toBeNull();
    expect(screen.queryByTestId("highlights-card")).toBeNull();
  });

  it("无工作空间时显示引导卡 + 理念卡，隐藏用量趋势", async () => {
    useWorkspacesStore.setState({ workspaces: [] });
    render(<HomeDashboard onOpenTerminal={vi.fn()} />);
    await screen.findByTestId("recent");

    expect(screen.getByTestId("getting-started")).toBeInTheDocument();
    expect(screen.getByTestId("highlights-card")).toBeInTheDocument();
    expect(screen.queryByTestId("usage-stats")).toBeNull();
    expect(screen.queryByTestId("highlights-compact")).toBeNull();
  });

  it("有工作空间但项目总数为 0 也算新用户", async () => {
    useWorkspacesStore.setState({ workspaces: [makeWorkspace(0), makeWorkspace(0)] });
    render(<HomeDashboard onOpenTerminal={vi.fn()} />);
    await screen.findByTestId("recent");

    expect(screen.getByTestId("getting-started")).toBeInTheDocument();
    expect(screen.queryByTestId("usage-stats")).toBeNull();
  });
});

import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useSshMachinesStore, useWorkspacesStore } from "@/stores";
import type { LaunchRecord } from "@/services";
import HomeRecentProjects from "./HomeRecentProjects";

let recordId = 0;

function createRecord(overrides: Partial<LaunchRecord> = {}): LaunchRecord {
  recordId += 1;
  return {
    id: recordId,
    projectId: `project-${recordId}`,
    projectName: `项目${recordId}`,
    projectPath: `D:/projects/p${recordId}`,
    launchedAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderRecent(records: LaunchRecord[]) {
  const onOpenTerminal = vi.fn();
  render(<HomeRecentProjects records={records} onOpenTerminal={onOpenTerminal} />);
  return { onOpenTerminal };
}

describe("HomeRecentProjects", () => {
  beforeEach(() => {
    recordId = 0;
    useWorkspacesStore.setState({ workspaces: [] });
    useSshMachinesStore.setState({ machines: [] });
    useActivityBarStore.setState({
      activeView: "explorer",
      sidebarVisible: true,
      appViewMode: "home",
      orchestrationOverlayOpen: false,
    });
  });

  it("无记录时显示空状态与创建入口", () => {
    renderRecent([]);

    expect(screen.getByText("暂无最近项目")).toBeVisible();

    fireEvent.click(screen.getByText("创建第一个工作空间"));

    const state = useActivityBarStore.getState();
    expect(state.appViewMode).toBe("panes");
    expect(state.activeView).toBe("explorer");
  });

  it("同一 projectPath 的记录去重只保留最近一条", () => {
    renderRecent([
      createRecord({ projectName: "最新启动", projectPath: "D:/same" }),
      createRecord({ projectName: "较早启动", projectPath: "D:/same" }),
    ]);

    expect(screen.getByText("最新启动")).toBeVisible();
    expect(screen.queryByText("较早启动")).not.toBeInTheDocument();
  });

  it("最多展示 8 个项目", () => {
    renderRecent(Array.from({ length: 10 }, () => createRecord()));

    expect(screen.getAllByTitle("打开")).toHaveLength(8);
  });

  it("按相对时间显示启动时间", () => {
    renderRecent([
      createRecord({ projectName: "刚启动的" }),
      createRecord({
        projectName: "五分钟前的",
        launchedAt: new Date(Date.now() - 5 * 60000).toISOString(),
      }),
      createRecord({
        projectName: "三小时前的",
        launchedAt: new Date(Date.now() - 3 * 3600000).toISOString(),
      }),
    ]);

    expect(screen.getByText("刚刚")).toBeVisible();
    expect(screen.getByText("5分钟前")).toBeVisible();
    expect(screen.getByText("3小时前")).toBeVisible();
  });

  it("点击打开按钮以项目路径打开终端并切换到 panes 模式", () => {
    const { onOpenTerminal } = renderRecent([
      createRecord({
        projectPath: "D:/projects/alpha",
        workspaceName: "ws-alpha",
        providerId: "provider-1",
      }),
    ]);

    fireEvent.click(screen.getByTitle("打开"));

    expect(onOpenTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "D:/projects/alpha",
        workspaceName: "ws-alpha",
        providerId: "provider-1",
      }),
    );
    expect(useActivityBarStore.getState().appViewMode).toBe("panes");
  });

  it("有 resumeSessionId 时显示恢复按钮并带 resumeId 打开", () => {
    const { onOpenTerminal } = renderRecent([
      createRecord({
        projectPath: "D:/projects/beta",
        resumeSessionId: "session-42",
        cliTool: "claude",
      }),
    ]);

    fireEvent.click(screen.getByTitle("恢复"));

    expect(onOpenTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "D:/projects/beta",
        resumeId: "session-42",
        cliTool: "claude",
      }),
    );
  });

  it("没有 resumeSessionId 时不显示恢复按钮", () => {
    renderRecent([createRecord()]);

    expect(screen.queryByTitle("恢复")).not.toBeInTheDocument();
  });

  it("点击查看全部切换到 panes 的 sessions 视图", () => {
    renderRecent([createRecord()]);

    fireEvent.click(screen.getByText("查看全部"));

    const state = useActivityBarStore.getState();
    expect(state.appViewMode).toBe("panes");
    expect(state.activeView).toBe("sessions");
  });
});

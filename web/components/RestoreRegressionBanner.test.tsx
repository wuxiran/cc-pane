import { render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RestoreRegressionBanner from "./RestoreRegressionBanner";
import { usePanesStore } from "@/stores/usePanesStore";
import { useRestoreReportStore } from "@/stores/useRestoreReportStore";
import type { Tab } from "@/types";
import { isRestoreRegression, logRestoreReport } from "@/utils/restoreReport";

function setSummary(total: number, withResumeId: number) {
  const missingResumeId = total > 0 && withResumeId === 0 ? total : 0;
  useRestoreReportStore.setState({
    summary: {
      total,
      withResumeId,
      withoutResumeId: total - withResumeId,
      adopted: 0,
      resumed: withResumeId + missingResumeId,
      fresh: total - withResumeId - missingResumeId,
      shell: 0,
      missingResumeId,
    },
    dismissed: false,
  });
}

describe("isRestoreRegression", () => {
  afterEach(() => vi.restoreAllMocks());

  it("只有 resumed leaf 丢失 resume id 才算回归", () => {
    // 这是 docs/69 那次事故的形状：18 个 tab，0 个带 resumeId
    expect(isRestoreRegression({
      total: 18,
      withResumeId: 0,
      withoutResumeId: 18,
      adopted: 0,
      resumed: 18,
      fresh: 0,
      shell: 0,
      missingResumeId: 18,
    })).toBe(true);

    // fresh leaf 没有 resumeId 是正常的。
    expect(isRestoreRegression({
      total: 18,
      withResumeId: 1,
      withoutResumeId: 17,
      adopted: 0,
      resumed: 1,
      fresh: 17,
      shell: 0,
      missingResumeId: 0,
    })).toBe(false);

    // 没有可恢复 tab 时不能报警，否则每次空启动都要弹一条
    expect(isRestoreRegression({
      total: 0,
      withResumeId: 0,
      withoutResumeId: 0,
      adopted: 0,
      resumed: 0,
      fresh: 0,
      shell: 0,
      missingResumeId: 0,
    })).toBe(false);
  });

  it("全是纯 shell 时不报警", () => {
    expect(isRestoreRegression({
      total: 0,
      withResumeId: 0,
      withoutResumeId: 0,
      adopted: 0,
      resumed: 0,
      fresh: 0,
      shell: 3,
      missingResumeId: 0,
    })).toBe(false);
  });

  it("按 split leaf 统计，并从 agent 总数中排除 shell", async () => {
    const tab = {
      id: "tab-split",
      title: "split",
      contentType: "terminal",
      projectId: "stable-tab-id",
      projectPath: "/repo",
      resumeId: "active-resume",
      sessionId: null,
      activeTerminalPaneId: "leaf-resumed",
      terminalRootPane: {
        type: "split",
        id: "terminal-split",
        direction: "horizontal",
        sizes: [34, 33, 33],
        children: [
          {
            type: "leaf",
            id: "leaf-resumed",
            sessionId: null,
            cliTool: "claude",
            resumeId: "active-resume",
            restoreMode: "resumed",
          },
          {
            type: "leaf",
            id: "leaf-shell",
            sessionId: null,
            cliTool: "none",
            restoreMode: "fresh",
          },
          {
            type: "leaf",
            id: "leaf-adopted",
            sessionId: "pty-live",
            cliTool: "codex",
            restoreMode: "adopted",
          },
        ],
      },
    } as Tab;
    vi.spyOn(usePanesStore.getState(), "getRestorableTabs").mockReturnValue([
      { tab, paneId: "panel-1", layoutId: "layout-1" },
    ]);

    const summary = await logRestoreReport();

    expect(summary).toEqual({
      total: 2,
      withResumeId: 1,
      withoutResumeId: 1,
      adopted: 1,
      resumed: 1,
      fresh: 0,
      shell: 1,
      missingResumeId: 0,
    });
  });
});

describe("RestoreRegressionBanner", () => {
  beforeEach(() => {
    useRestoreReportStore.setState({ summary: null, dismissed: false });
  });

  it("全员未绑定时告警，且带可读的排障指向", () => {
    setSummary(18, 0);
    render(<RestoreRegressionBanner />);

    const alert = screen.getByRole("alert");
    expect(alert).toBeVisible();
    expect(alert.textContent).toContain("18");
    expect(alert.textContent).toContain("restore-report");
  });

  it("未绑定项都属于 fresh 时不打扰", () => {
    setSummary(18, 5);
    const { container } = render(<RestoreRegressionBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("全是纯 shell 时不报警", () => {
    useRestoreReportStore.setState({
      summary: {
        total: 0,
        withResumeId: 0,
        withoutResumeId: 0,
        adopted: 0,
        resumed: 0,
        fresh: 0,
        shell: 3,
        missingResumeId: 0,
      },
      dismissed: false,
    });

    const { container } = render(<RestoreRegressionBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("报告还没出来时不渲染", () => {
    const { container } = render(<RestoreRegressionBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("关掉之后不再打扰", () => {
    setSummary(18, 0);
    const { container } = render(<RestoreRegressionBanner />);
    fireEvent.click(screen.getByRole("button"));
    expect(container).toBeEmptyDOMElement();
  });
});

import "@/i18n";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Popover } from "@/components/ui/popover";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useUsageStatsStore } from "@/stores";
import type { SystemStats } from "@/types";
import {
  SystemResourcePopover,
  type WorkspaceGroup,
} from "./SystemResourcePopover";
import UsageStatsStatusButton from "./UsageStatsStatusButton";

const headerStats: SystemStats = {
  cpuPercent: 12.4,
  memUsed: 18.2 * 1024 ** 3,
  memTotal: 64 * 1024 ** 3,
};

const groups: WorkspaceGroup[] = [
  { name: "Workspace A", sessions: [], cpuPercent: 7.5, memoryBytes: 256 * 1024 ** 2 },
];

function renderResourcePopover(collapsedGroups: Set<string>, orphansExpanded = false) {
  return render(
    <TooltipProvider>
      <Popover open>
        <SystemResourcePopover
          headerStats={headerStats}
          tree={null}
          groups={groups}
          collapsedGroups={collapsedGroups}
          refreshing={false}
          armedSessionId={null}
          killingSessionId={null}
          orphansExpanded={orphansExpanded}
          orphanKillArmed={false}
          killingOrphans={false}
          expandedSessionIds={new Set()}
          onRefresh={() => {}}
          onToggleGroup={() => {}}
          onToggleSessionProcesses={() => {}}
          onFocusSession={() => {}}
          onArmSession={() => {}}
          onKillSession={() => {}}
          onToggleOrphans={() => {}}
          onArmOrphanKill={() => {}}
          onKillOrphans={() => {}}
        />
      </Popover>
    </TooltipProvider>,
  );
}

describe("SystemResourcePopover 折叠按钮 aria-expanded", () => {
  it("工作区分组折叠按钮暴露展开状态", () => {
    renderResourcePopover(new Set());
    expect(
      screen.getByRole("button", { name: /Workspace A/ }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("分组被折叠时 aria-expanded 为 false", () => {
    renderResourcePopover(new Set(["Workspace A"]));
    expect(
      screen.getByRole("button", { name: /Workspace A/ }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("孤立进程折叠按钮暴露展开状态", () => {
    renderResourcePopover(new Set(), true);
    expect(
      screen.getByRole("button", { name: "折叠孤立进程" }),
    ).toHaveAttribute("aria-expanded", "true");
  });
});

const usageData = {
  series: [],
  totals: {
    charCount: 1200,
    tokenInput: 0,
    tokenOutput: 0,
    tokenCacheRead: 0,
    tokenCacheCreation: 0,
  },
  byCli: {
    claude: {
      charCount: 0,
      tokenInput: 100,
      tokenOutput: 200,
      tokenCacheRead: 300,
      tokenCacheCreation: 50,
    },
  },
  workspaces: [],
};

describe("UsageStatsStatusButton 键盘可达性", () => {
  beforeEach(() => {
    act(() => {
      useUsageStatsStore.setState({
        data: usageData,
        loading: false,
        error: null,
      });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    act(() => {
      useUsageStatsStore.setState({ data: null, loading: false, error: null });
    });
  });

  it("键盘 Enter 展开预览并同步 aria-expanded/controls", () => {
    render(<UsageStatsStatusButton />);

    const button = screen.getByTestId("usage-stats-status-button");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByTestId("usage-stats-hover-preview"),
    ).not.toBeInTheDocument();

    fireEvent.keyDown(button, { key: "Enter" });

    const preview = screen.getByTestId("usage-stats-hover-preview");
    expect(preview).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).toHaveAttribute("aria-controls", "usage-stats-hover-preview");
    // aria-controls 必须指向真实存在的元素
    expect(preview).toHaveAttribute("id", "usage-stats-hover-preview");
  });

  it("纯聚焦不展开（防 Popover 焦点陷阱拉扯），Escape 关闭", () => {
    render(<UsageStatsStatusButton />);

    const button = screen.getByTestId("usage-stats-status-button");
    fireEvent.focus(button);
    expect(
      screen.queryByTestId("usage-stats-hover-preview"),
    ).not.toBeInTheDocument();

    fireEvent.keyDown(button, { key: "ArrowDown" });
    expect(screen.getByTestId("usage-stats-hover-preview")).toBeInTheDocument();

    fireEvent.keyDown(button, { key: "Escape" });
    expect(
      screen.queryByTestId("usage-stats-hover-preview"),
    ).not.toBeInTheDocument();
  });

  it("焦点在容器内移动（进入预览区域）不关闭", () => {
    render(<UsageStatsStatusButton />);

    const button = screen.getByTestId("usage-stats-status-button");
    fireEvent.keyDown(button, { key: "Enter" });
    const preview = screen.getByTestId("usage-stats-hover-preview");

    fireEvent.blur(button, { relatedTarget: preview });

    expect(screen.getByTestId("usage-stats-hover-preview")).toBeInTheDocument();
  });

  it("焦点真正离开容器后按既有 320ms 延时关闭", () => {
    vi.useFakeTimers();
    render(<UsageStatsStatusButton />);

    const button = screen.getByTestId("usage-stats-status-button");
    fireEvent.keyDown(button, { key: "Enter" });
    expect(screen.getByTestId("usage-stats-hover-preview")).toBeInTheDocument();

    fireEvent.blur(button, { relatedTarget: document.body });
    act(() => {
      vi.advanceTimersByTime(320);
    });

    expect(
      screen.queryByTestId("usage-stats-hover-preview"),
    ).not.toBeInTheDocument();
    expect(button).toHaveAttribute("aria-expanded", "false");
  });
});

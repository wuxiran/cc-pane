import "@/i18n";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Popover } from "@/components/ui/popover";
import { TooltipProvider } from "@/components/ui/tooltip";
import { systemStatsService } from "@/services/systemStatsService";
import { useSettingsStore, useTerminalStatusStore } from "@/stores";
import { useResourcePopoverStore } from "@/stores/useResourcePopoverStore";
import type { ResourceTree, TerminalStatusInfo } from "@/types";
import { SystemResourcePopover, type WorkspaceGroup } from "./SystemResourcePopover";
import { policyForMode, policyModeOf } from "./useSessionResourcePolicy";

vi.mock("@/services/systemStatsService", () => ({
  systemStatsService: {
    get: vi.fn(),
    getResourceTree: vi.fn(),
    killOrphans: vi.fn(),
    setSessionResourcePolicy: vi.fn(),
  },
}));
vi.mock("@/services/heavyCommandService", () => ({
  heavyCommandService: { list: vi.fn(async () => []), aggregate: vi.fn(async () => []), clear: vi.fn() },
}));

const stats = { cpuPercent: 72, memUsed: 20 * 1024 ** 3, memTotal: 64 * 1024 ** 3 };

const tree: ResourceTree = {
  system: stats,
  appMemoryBytes: 1,
  appMemoryPercent: 0.1,
  sessions: [{ sessionId: "s1", rootPid: 20, cpuPercent: 310, memoryBytes: 2e9, processCount: 3 }],
  orphans: [],
  topProcesses: [
    { pid: 900, name: "msedge.exe", cpuPercent: 240.5, memoryBytes: 3 * 1024 ** 3 },
    { pid: 901, name: "rustc.exe", cpuPercent: 120, memoryBytes: 512 * 1024 ** 2 },
  ],
  sampledAt: 1,
  elapsedMicros: 1,
};

const groups: WorkspaceGroup[] = [
  {
    name: "ws",
    cpuPercent: 310,
    memoryBytes: 2e9,
    sessions: [
      {
        ...tree.sessions[0],
        title: "build pane",
        workspaceName: "ws",
        adoptable: false,
        claimBlocked: false,
        cliTool: "claude",
        status: "toolRunning",
        toolName: "Bash",
      },
    ],
  },
];

function setStatus(resourcePolicy: TerminalStatusInfo["resourcePolicy"]) {
  const map = new Map<string, TerminalStatusInfo>();
  map.set("s1", { sessionId: "s1", status: "toolRunning", lastOutputAt: 1, updatedAt: 1, resourcePolicy });
  useTerminalStatusStore.setState({ statusMap: map });
}

function renderPopover(treeOverride: ResourceTree | null = tree) {
  const noop = vi.fn();
  return render(
    <TooltipProvider>
      <Popover open>
        <SystemResourcePopover
          headerStats={stats}
          tree={treeOverride}
          groups={groups}
          collapsedGroups={new Set()}
          refreshing={false}
          armedSessionId={null}
          killingSessionId={null}
          orphansExpanded={false}
          orphanKillArmed={false}
          killingOrphans={false}
          expandedSessionIds={new Set()}
          onRefresh={noop}
          onToggleGroup={noop}
          onToggleSessionProcesses={noop}
          onFocusSession={noop}
          onArmSession={noop}
          onKillSession={noop}
          onToggleOrphans={noop}
          onArmOrphanKill={noop}
          onKillOrphans={noop}
        />
      </Popover>
    </TooltipProvider>,
  );
}

describe("SystemResourcePopover (W4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setStatus(undefined);
    useResourcePopoverStore.setState({ open: true, highlightSessionId: null });
    // 测试环境没有加载设置（settings 为 null）→ "让路/效率模式"的 cpuWeight 回落 null
    expect(useSettingsStore.getState().settings).toBeNull();
  });
  afterEach(cleanup);

  it("renders the read-only 'outside sessions' block only when the backend provides it", () => {
    renderPopover();
    const block = screen.getByTestId("top-processes-block");
    expect(block).toHaveTextContent("msedge.exe");
    expect(block).toHaveTextContent("PID 900 · 240.5%");
    expect(block).toHaveTextContent("rustc.exe");
    // 只读：块内没有任何按钮
    expect(block.querySelector("button")).toBeNull();
    cleanup();
    renderPopover({ ...tree, topProcesses: undefined });
    expect(screen.queryByTestId("top-processes-block")).toBeNull();
    cleanup();
    renderPopover({ ...tree, topProcesses: [] });
    expect(screen.queryByTestId("top-processes-block")).toBeNull();
  });

  it("session row exposes the three-state policy control and sends the mapped policy", async () => {
    vi.mocked(systemStatsService.setSessionResourcePolicy).mockResolvedValue({
      outcome: "applied",
      lowerPriority: true,
      ecoQos: true,
    });
    renderPopover();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    // 无状态 → 默认"正常"选中
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    fireEvent.click(radios[2]);
    await waitFor(() =>
      expect(systemStatsService.setSessionResourcePolicy).toHaveBeenCalledWith("s1", {
        lowerPriority: true,
        cpuWeight: null,
        ecoQos: true,
      }),
    );
    // 返回值先写回 store：效率模式立刻选中，不等下一次状态事件
    await waitFor(() => expect(screen.getAllByRole("radio")[2]).toHaveAttribute("aria-checked", "true"));
  });

  it("shows degraded / unsupported reasons under the row", () => {
    setStatus({ outcome: "degraded", reason: "eco qos: 2/5 processes failed", lowerPriority: true, ecoQos: true });
    renderPopover();
    expect(screen.getByTestId("resource-policy-degraded")).toHaveTextContent("eco qos: 2/5 processes failed");
    expect(screen.getAllByRole("radio")[2]).toHaveAttribute("aria-checked", "true");
    cleanup();
    setStatus({ outcome: "unsupported", reason: "daemon too old", lowerPriority: false, ecoQos: false });
    renderPopover();
    expect(screen.getByTestId("resource-policy-degraded")).toHaveTextContent("daemon too old");
    cleanup();
    setStatus({ outcome: "applied", lowerPriority: true, ecoQos: false });
    renderPopover();
    expect(screen.queryByTestId("resource-policy-degraded")).toBeNull();
    expect(screen.getAllByRole("radio")[1]).toHaveAttribute("aria-checked", "true");
  });

  it("shows the job memory watermark line while the status carries a warning", () => {
    const map = new Map<string, TerminalStatusInfo>();
    map.set("s1", {
      sessionId: "s1",
      status: "toolRunning",
      lastOutputAt: 1,
      updatedAt: 1,
      jobMemoryWarning: { bytes: 20 * 1024 ** 3, limitBytes: 16 * 1024 ** 3, at: 1 },
    });
    useTerminalStatusStore.setState({ statusMap: map });
    renderPopover();
    const line = screen.getByTestId("job-memory-warning");
    expect(line).toHaveTextContent("20");
    expect(line).toHaveTextContent("16");
    cleanup();
    setStatus(undefined);
    renderPopover();
    expect(screen.queryByTestId("job-memory-warning")).toBeNull();
  });

  it("labels cgroup-sourced readings and leaves tree-aggregated rows unlabeled", () => {
    renderPopover();
    expect(screen.queryByTestId("resource-source-cgroup")).toBeNull();
    cleanup();
    const wslGroups: WorkspaceGroup[] = [
      { ...groups[0], sessions: [{ ...groups[0].sessions[0], source: "cgroup" }] },
    ];
    const noop = vi.fn();
    render(
      <TooltipProvider>
        <Popover open>
          <SystemResourcePopover
            headerStats={stats}
            tree={tree}
            groups={wslGroups}
            collapsedGroups={new Set()}
            refreshing={false}
            armedSessionId={null}
            killingSessionId={null}
            orphansExpanded={false}
            orphanKillArmed={false}
            killingOrphans={false}
            expandedSessionIds={new Set()}
            onRefresh={noop}
            onToggleGroup={noop}
            onToggleSessionProcesses={noop}
            onFocusSession={noop}
            onArmSession={noop}
            onKillSession={noop}
            onToggleOrphans={noop}
            onArmOrphanKill={noop}
            onKillOrphans={noop}
          />
        </Popover>
      </TooltipProvider>,
    );
    expect(screen.getByTestId("resource-source-cgroup")).toHaveTextContent("cgroup");
  });

  it("highlights the session the tab badge asked for", () => {
    useResourcePopoverStore.setState({ open: true, highlightSessionId: "s1" });
    renderPopover();
    expect(screen.getByTestId("resource-session-s1").className).toContain("ring-1");
  });
});

describe("policy mode mapping", () => {
  it("policyModeOf", () => {
    expect(policyModeOf(null)).toBe("normal");
    expect(policyModeOf({ outcome: "applied", lowerPriority: false, ecoQos: false })).toBe("normal");
    expect(policyModeOf({ outcome: "applied", lowerPriority: true, ecoQos: false })).toBe("yield");
    expect(policyModeOf({ outcome: "degraded", lowerPriority: true, ecoQos: true })).toBe("eco");
  });

  it("policyForMode", () => {
    expect(policyForMode("normal", 3)).toEqual({ lowerPriority: false, cpuWeight: null, ecoQos: false });
    expect(policyForMode("yield", 3)).toEqual({ lowerPriority: true, cpuWeight: 3, ecoQos: false });
    expect(policyForMode("eco", null)).toEqual({ lowerPriority: true, cpuWeight: null, ecoQos: true });
  });
});

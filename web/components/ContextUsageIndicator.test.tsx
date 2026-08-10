import "@/i18n";
import i18n from "@/i18n";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PropsWithChildren } from "react";
import { useContextUsageStore } from "@/stores/useContextUsageStore";
import { useLaunchProfilesStore } from "@/stores/useLaunchProfilesStore";
import { useProvidersStore } from "@/stores/useProvidersStore";
import type { ContextUsageSnapshot } from "@/types/contextUsage";
import ContextUsageIndicator from "./ContextUsageIndicator";

const contextUsagePollerMock = vi.hoisted(() => vi.fn(
  (context?: { sessionId?: string | null }) => context?.sessionId ?? "pty-context",
));

vi.mock("@/hooks/useContextUsagePoller", () => ({
  useContextUsagePoller: contextUsagePollerMock,
}));

vi.mock("@/hooks/useActiveTerminalSession", () => ({
  useActiveTerminalContext: () => null,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: PropsWithChildren) => <>{children}</>,
  TooltipContent: ({ children }: PropsWithChildren) => <div>{children}</div>,
}));

const { navigateToSettingsMock } = vi.hoisted(() => ({
  navigateToSettingsMock: vi.fn(),
}));
vi.mock("@/components/settings/settingsNavigation", () => ({
  navigateToSettings: navigateToSettingsMock,
}));

function snapshot(overrides: Partial<ContextUsageSnapshot> = {}): ContextUsageSnapshot {
  return {
    status: "ready",
    usedTokens: 81_234,
    effectiveUsedTokens: 81_234,
    windowTokens: null,
    effectiveWindowTokens: null,
    usedPercentage: null,
    remainingPercentage: null,
    model: "claude-sonnet",
    usageSource: "claude-jsonl",
    windowSource: "unknown",
    agentSessionId: "resume-context",
    parserVersion: "1",
    observedAt: Date.now(),
    diagnosticCode: "WINDOW_UNKNOWN",
    ...overrides,
  };
}

function setSnapshot(value: ContextUsageSnapshot, lastReady: ContextUsageSnapshot | null = value) {
  useContextUsageStore.setState({
    sessionId: "pty-context",
    snapshot: value,
    lastReady,
    loading: false,
  });
}

describe("ContextUsageIndicator", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    useLaunchProfilesStore.setState({ profiles: [], loading: false });
    useProvidersStore.setState({ providers: [] });
    useContextUsageStore.setState({ sessions: new Map() });
  });

  it("reads the snapshot for an explicitly supplied grid terminal", () => {
    const gridSnapshot = snapshot({
      usedPercentage: 73,
      remainingPercentage: 27,
      windowTokens: 100_000,
      effectiveWindowTokens: 100_000,
      diagnosticCode: null,
    });
    useContextUsageStore.setState({
      sessions: new Map([["pty-grid", {
        snapshot: gridSnapshot,
        lastReady: gridSnapshot,
        loading: false,
        requestId: 1,
      }]]),
    });

    render(<ContextUsageIndicator terminalContext={{
      sessionId: "pty-grid",
      cliTool: "claude",
      ssh: false,
      providerId: null,
      modelId: null,
      providerSelection: null,
      launchProfileId: null,
    }} />);

    expect(contextUsagePollerMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "pty-grid" }),
      true,
    );
    expect(screen.getByTestId("context-usage-indicator")).toHaveTextContent("73%");
  });

  it("shows an unknown percentage with a Provider maintenance action", () => {
    setSnapshot(snapshot());
    render(<ContextUsageIndicator />);

    expect(screen.getAllByText("-%").length).toBeGreaterThan(0);
    expect(screen.getByText(/请在 Provider 模型设置中配置/)).toBeInTheDocument();
    expect(screen.queryByText(/窗口来源/)).not.toBeInTheDocument();
  });

  it("WINDOW_UNKNOWN 提示文案包含可点击的「去 Provider 设置」按钮，点击后跳到 providers pane", async () => {
    const user = userEvent.setup();
    navigateToSettingsMock.mockClear();
    setSnapshot(snapshot());
    render(<ContextUsageIndicator />);

    const link = screen.getByRole("button", { name: /去 Provider 设置/ });
    expect(link).toBeInTheDocument();
    await user.click(link);

    expect(navigateToSettingsMock).toHaveBeenCalledWith({ paneId: "providers" });
  });

  it("renders a compact usage summary", () => {
    setSnapshot(snapshot({
      windowTokens: 1_000_000,
      effectiveWindowTokens: 1_000_000,
      usedPercentage: 8,
      remainingPercentage: 92,
      windowSource: "provider-model",
      diagnosticCode: null,
    }));
    render(<ContextUsageIndicator />);

    expect(screen.getAllByText(/8%/).length).toBeGreaterThan(0);
    expect(screen.getByTestId("context-usage-indicator")).toHaveTextContent("8%");
    expect(screen.getByTestId("context-usage-indicator")).not.toHaveTextContent("81k");
    expect(screen.getByText(/· 81k \/ 1.0m/).parentElement).toHaveTextContent("8% · 81k / 1.0m");
    expect(screen.queryByText(/窗口来源/)).not.toBeInTheDocument();
  });

  it("keeps the waiting state separate from an unknown window", () => {
    setSnapshot(snapshot({
      status: "waiting",
      usedTokens: null,
      effectiveUsedTokens: null,
      usageSource: null,
      windowSource: null,
      diagnosticCode: "WAITING_FIRST_RESPONSE",
    }), null);
    render(<ContextUsageIndicator />);

    expect(screen.getByText("等待首条用量数据")).toBeInTheDocument();
    expect(screen.queryByText(/窗口来源/)).not.toBeInTheDocument();
  });
});

import "@/i18n";
import i18n from "@/i18n";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PropsWithChildren } from "react";
import { useContextUsageStore } from "@/stores/useContextUsageStore";
import { useLaunchProfilesStore } from "@/stores/useLaunchProfilesStore";
import { useProvidersStore } from "@/stores/useProvidersStore";
import type { ContextUsageSnapshot } from "@/types/contextUsage";
import ContextUsageIndicator from "./ContextUsageIndicator";

vi.mock("@/hooks/useContextUsagePoller", () => ({
  useContextUsagePoller: () => "pty-context",
}));

vi.mock("@/hooks/useActiveTerminalSession", () => ({
  useActiveTerminalContext: () => null,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: PropsWithChildren) => <>{children}</>,
  TooltipContent: ({ children }: PropsWithChildren) => <div>{children}</div>,
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
  });

  it("shows an unknown percentage with a Provider maintenance action", () => {
    setSnapshot(snapshot());
    render(<ContextUsageIndicator />);

    expect(screen.getAllByText("-%").length).toBeGreaterThan(0);
    expect(screen.getByText(/请在 Provider 模型设置中配置/)).toBeInTheDocument();
    expect(screen.getByText("窗口来源：未知")).toBeInTheDocument();
  });

  it("renders a localized Provider model source", () => {
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
    expect(screen.getByText("窗口来源：Provider 模型配置")).toBeInTheDocument();
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

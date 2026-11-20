import "@/i18n";
import i18n from "@/i18n";
import { render, screen } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveTerminalContext } from "@/hooks/useActiveTerminalSession";
import { useSessionCostStore } from "@/stores/useSessionCostStore";
import type { RateLimitSnapshot } from "@/types/rateLimit";
import type { SessionCostSnapshot } from "@/types/sessionCost";
import RateLimitIndicator from "./RateLimitIndicator";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: PropsWithChildren) => <>{children}</>,
  TooltipContent: ({ children }: PropsWithChildren) => <div>{children}</div>,
}));

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const HOUR = 3_600_000;

const context = {
  sessionId: "pty-1",
  cliTool: "codex",
  ssh: false,
  providerId: null,
} as ActiveTerminalContext;

function seed(rateLimits: RateLimitSnapshot | null) {
  const snapshot: SessionCostSnapshot = {
    status: "ready",
    costUsd: 1,
    hasUnpricedUsage: false,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    models: [],
    pricingAsOf: "2026-11-02",
    agentSessionId: "agent-1",
    observedAt: NOW,
    diagnosticCode: null,
    rateLimits,
  };
  useSessionCostStore.setState({
    sessions: new Map([["pty-1", { snapshot, loading: false, requestId: 1 }]]),
  });
}

const codex: RateLimitSnapshot = {
  source: "codex-session-log",
  windows: [
    { slot: "primary", usedPercent: 12.4, windowMinutes: 300, resetsAt: NOW + 3 * HOUR },
    { slot: "secondary", usedPercent: 81, windowMinutes: 10080, resetsAt: NOW + 50 * HOUR },
  ],
  planType: "pro",
  limitReachedType: null,
  observedAt: NOW - 60_000,
};

describe("RateLimitIndicator", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.useRealTimers();
    useSessionCostStore.setState({ sessions: new Map() });
  });

  it("shows each window and the reset countdown of the most used one", () => {
    seed(codex);
    render(<RateLimitIndicator terminalContext={context} />);
    const indicator = screen.getByTestId("rate-limit-indicator");
    expect(indicator.textContent).toBe("5h 12% · 7d 81% ↻2d2h");
    expect(indicator.style.color).toBe("var(--app-status-warning)");
    expect(screen.getAllByTestId("rate-limit-window")).toHaveLength(2);
    expect(screen.getByText("Weekly window")).toBeTruthy();
    expect(screen.getByText("81% used")).toBeTruthy();
  });

  it("renders nothing without data, so engines without a source show no fake number", () => {
    seed(null);
    const { container } = render(<RateLimitIndicator terminalContext={context} />);
    expect(container.textContent).toBe("");
  });

  it("hides windows that already reset", () => {
    seed({
      ...codex,
      windows: [{ ...codex.windows[0], resetsAt: NOW - 1 }],
    });
    const { container } = render(<RateLimitIndicator terminalContext={context} />);
    expect(container.textContent).toBe("");
  });

  it("flags a reached limit", () => {
    seed({ ...codex, limitReachedType: "primary" });
    render(<RateLimitIndicator terminalContext={context} />);
    expect(screen.getByTestId("rate-limit-indicator").style.color).toBe("var(--app-status-danger)");
    expect(screen.getByText(/Limit reached/)).toBeTruthy();
  });

  it("ignores SSH sessions", () => {
    seed(codex);
    const { container } = render(
      <RateLimitIndicator terminalContext={{ ...context, ssh: true } as ActiveTerminalContext} />,
    );
    expect(container.textContent).toBe("");
  });
});

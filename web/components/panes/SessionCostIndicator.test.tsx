import "@/i18n";
import i18n from "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveTerminalContext } from "@/hooks/useActiveTerminalSession";
import { usageStatsService } from "@/services/usageStatsService";
import { useSessionCostStore } from "@/stores/useSessionCostStore";
import type { SessionCostSnapshot } from "@/types/sessionCost";
import SessionCostIndicator, { formatUsd } from "./SessionCostIndicator";

vi.mock("@/services/usageStatsService", () => ({
  usageStatsService: { querySessionCost: vi.fn() },
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: PropsWithChildren) => <>{children}</>,
  TooltipContent: ({ children }: PropsWithChildren) => <div>{children}</div>,
}));

const query = vi.mocked(usageStatsService.querySessionCost);

const context: ActiveTerminalContext = {
  sessionId: "pty-1",
  cliTool: "claude",
  ssh: false,
  providerId: null,
} as ActiveTerminalContext;

function snapshot(overrides: Partial<SessionCostSnapshot> = {}): SessionCostSnapshot {
  return {
    status: "ready",
    costUsd: 12.345,
    hasUnpricedUsage: false,
    inputTokens: 500,
    outputTokens: 12_000,
    cacheReadTokens: 3_400_000,
    cacheWriteTokens: 250_000,
    models: [{ model: "claude-opus-5-5", costUsd: 12.345 }],
    pricingAsOf: "2026-11-02",
    agentSessionId: "agent-1",
    observedAt: 1,
    diagnosticCode: null,
    ...overrides,
  };
}

describe("formatUsd", () => {
  it.each([
    [0, "<$0.01"],
    [0.009, "<$0.01"],
    [0.01, "$0.01"],
    [12.345, "$12.35"],
    [99.99, "$99.99"],
    [100, "$100"],
    [2279.43, "$2,279"],
  ])("formats %s as %s", (value, expected) => {
    expect(formatUsd(value)).toBe(expected);
  });
});

describe("SessionCostIndicator", () => {
  beforeEach(async () => {
    query.mockReset();
    useSessionCostStore.setState({ sessions: new Map() });
    await i18n.changeLanguage("en");
  });

  it("shows the estimate and token breakdown", async () => {
    query.mockResolvedValue(snapshot());
    render(<SessionCostIndicator terminalContext={context} />);

    await waitFor(() => {
      expect(screen.getByTestId("session-cost-indicator")).toHaveTextContent("≈$12.35");
    });
    expect(query).toHaveBeenCalledWith("pty-1");
    expect(screen.getByText("Input tokens").parentElement).toHaveTextContent("500");
    expect(screen.getByText("Output tokens").parentElement).toHaveTextContent("12k");
    expect(screen.getByText("Cache read tokens").parentElement).toHaveTextContent("3.4M");
    expect(screen.getByText("Cache write tokens").parentElement).toHaveTextContent("250k");
    expect(screen.getByText(/2026-11-02/)).toBeInTheDocument();
  });

  it("marks a partial total and names the unpriced model", async () => {
    query.mockResolvedValue(snapshot({
      hasUnpricedUsage: true,
      models: [
        { model: "claude-opus-5-5", costUsd: 12.345 },
        { model: "deepseek-v4-pro", costUsd: null },
      ],
    }));
    render(<SessionCostIndicator terminalContext={context} />);

    await waitFor(() => {
      expect(screen.getByTestId("session-cost-indicator")).toHaveTextContent("≈$12.35+");
    });
    expect(screen.getByText(/deepseek-v4-pro/)).toBeInTheDocument();
  });

  it("shows no amount when nothing can be priced", async () => {
    query.mockResolvedValue(snapshot({
      costUsd: null,
      hasUnpricedUsage: true,
      models: [{ model: "deepseek-v4-pro", costUsd: null }],
    }));
    render(<SessionCostIndicator terminalContext={context} />);

    await waitFor(() => expect(screen.getByText(/deepseek-v4-pro/)).toBeInTheDocument());
    expect(screen.getByTestId("session-cost-indicator")).toHaveTextContent("$—");
  });

  it("shows a placeholder while waiting for the first response", async () => {
    query.mockResolvedValue(snapshot({
      status: "waiting",
      costUsd: null,
      diagnosticCode: "WAITING_FIRST_RESPONSE",
    }));
    render(<SessionCostIndicator terminalContext={context} />);

    await waitFor(() => expect(query).toHaveBeenCalled());
    expect(screen.getByTestId("session-cost-indicator")).toHaveTextContent("$—");
  });

  it.each([
    ["a CLI without usage parsing", { ...context, cliTool: "gemini" }],
    ["an SSH session", { ...context, ssh: true }],
    ["a tab without a session", { ...context, sessionId: null }],
  ])("renders nothing and never polls for %s", (_name, terminalContext) => {
    render(<SessionCostIndicator terminalContext={terminalContext as ActiveTerminalContext} />);
    expect(screen.queryByTestId("session-cost-indicator")).not.toBeInTheDocument();
    expect(query).not.toHaveBeenCalled();
  });

  it("does not poll while disabled", () => {
    render(<SessionCostIndicator terminalContext={context} enabled={false} />);
    expect(query).not.toHaveBeenCalled();
  });

  it("hides itself when the backend reports the runtime as unsupported", async () => {
    query.mockResolvedValue(snapshot({
      status: "error",
      costUsd: null,
      diagnosticCode: "RUNTIME_UNSUPPORTED",
    }));
    render(<SessionCostIndicator terminalContext={context} />);

    await waitFor(() => {
      expect(screen.queryByTestId("session-cost-indicator")).not.toBeInTheDocument();
    });
  });
});

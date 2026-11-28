import "@/i18n";
import i18n from "@/i18n";
import { act, render, screen } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveTerminalContext } from "@/hooks/useActiveTerminalSession";
import {
  MAGPIE_ROUTE_LONG_POLL_SECS,
  MAGPIE_ROUTE_MIN_GAP_MS,
  MAGPIE_ROUTE_OFFLINE_RETRY_MS,
} from "@/hooks/useMagpieSessionRoute";
import { magpieService } from "@/services/magpieService";
import type { MagpieRouteStatus } from "@/types/magpie";
import MagpieRouteIndicator from "./MagpieRouteIndicator";

vi.mock("@/services/magpieService", () => ({
  magpieService: { getSessionRoute: vi.fn() },
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: PropsWithChildren) => <>{children}</>,
  TooltipContent: ({ children }: PropsWithChildren) => <div>{children}</div>,
}));

const getRoute = vi.mocked(magpieService.getSessionRoute);

const context = {
  sessionId: "pty-1",
  cliTool: "claude",
  ssh: false,
  providerId: "magpie",
} as ActiveTerminalContext;

function status(overrides: Partial<MagpieRouteStatus> = {}): MagpieRouteStatus {
  return {
    available: true,
    sessionKey: "abc",
    seq: 7,
    switchCount: 2,
    route: {
      id: 1,
      asked: "group/code",
      group: "code",
      rule: { n: 1, useMember: "claude/opus", pick: "high" },
      model: "copilot/claude-opus-5.5",
      effort: "high",
      tries: [
        { model: "claude/claude-opus-5-5", done: true, status: 429, fail: "rate limited" },
        { model: "copilot/claude-opus-5.5", done: false },
      ],
      done: false,
      ttftMs: 420,
    },
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("MagpieRouteIndicator", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    getRoute.mockReset();
    await i18n.changeLanguage("zh-CN");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the current member and switch count, then long-polls with the seq", async () => {
    getRoute.mockResolvedValue(status());
    render(<MagpieRouteIndicator terminalContext={context} />);
    await flush();
    expect(screen.getByTestId("magpie-route-indicator").textContent).toBe(
      "copilot/claude-opus-5.5 · 换过 2 次",
    );
    expect(screen.getByTestId("magpie-route-tries").textContent).toContain("429 rate limited");
    expect(getRoute).toHaveBeenNthCalledWith(1, "pty-1");

    await act(async () => {
      vi.advanceTimersByTime(MAGPIE_ROUTE_MIN_GAP_MS);
    });
    await flush();
    expect(getRoute).toHaveBeenNthCalledWith(2, "pty-1", 7, MAGPIE_ROUTE_LONG_POLL_SECS);
  });

  it("stays hidden and backs off when Magpie is unavailable", async () => {
    getRoute.mockResolvedValue({ available: false, seq: 0, switchCount: 0 });
    render(<MagpieRouteIndicator terminalContext={context} />);
    await flush();
    expect(screen.queryByTestId("magpie-route-indicator")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(MAGPIE_ROUTE_OFFLINE_RETRY_MS - 1);
    });
    expect(getRoute).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await flush();
    expect(getRoute).toHaveBeenCalledTimes(2);
    expect(getRoute).toHaveBeenLastCalledWith("pty-1");
  });

  it("hides with no route yet and omits a zero switch count", async () => {
    getRoute.mockResolvedValueOnce(status({ route: null }));
    const { unmount } = render(<MagpieRouteIndicator terminalContext={context} />);
    await flush();
    expect(screen.queryByTestId("magpie-route-indicator")).toBeNull();
    unmount();

    getRoute.mockResolvedValue(status({ switchCount: 0 }));
    render(<MagpieRouteIndicator terminalContext={context} />);
    await flush();
    expect(screen.getByTestId("magpie-route-indicator").textContent).toBe("copilot/claude-opus-5.5");
  });

  it("does not poll when invisible, over SSH, or for other CLIs", async () => {
    render(<MagpieRouteIndicator terminalContext={context} enabled={false} />);
    render(<MagpieRouteIndicator terminalContext={{ ...context, ssh: true }} />);
    render(<MagpieRouteIndicator terminalContext={{ ...context, cliTool: "gemini" }} />);
    await flush();
    expect(getRoute).not.toHaveBeenCalled();
  });
});

import "@/i18n";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorStatus } from "@/types";
import { useOrchestratorStatus } from "@/hooks/useOrchestratorStatus";
import OrchestratorAlertBanner from "./OrchestratorAlertBanner";

vi.mock("@/hooks/useOrchestratorStatus", () => ({
  useOrchestratorStatus: vi.fn(),
}));

const status = (overrides: Partial<OrchestratorStatus>): OrchestratorStatus => ({
  port: null,
  bind: { host: "127.0.0.1", mode: "auto", reason: "test" },
  lifecycle: "binding",
  attempt: 1,
  lastError: "port occupied",
  nextRetryAt: Date.now() + 1_000,
  ...overrides,
});

describe("OrchestratorAlertBanner", () => {
  beforeEach(() => vi.clearAllMocks());

  it("绑定重试期间显示 attempt 和可读的下次重试时间", () => {
    vi.mocked(useOrchestratorStatus).mockReturnValue(status({ attempt: 2 }));

    render(<OrchestratorAlertBanner />);

    expect(screen.getByRole("status")).toHaveTextContent("第 2 次");
    expect(screen.getByRole("status")).toHaveTextContent("下次重试");
  });

  it("重试穷尽后明确告知 MCP 不可用和逃生阀", () => {
    vi.mocked(useOrchestratorStatus).mockReturnValue(
      status({ lifecycle: "failed", attempt: 5, nextRetryAt: null }),
    );

    render(<OrchestratorAlertBanner />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("MCP 服务未启动");
    expect(alert).toHaveTextContent("已注入的 CLI 会话无法使用 MCP 工具");
    expect(alert).toHaveTextContent("CC_PANES_ORCHESTRATOR_PORT");
  });

  it("首次绑定尚未失败以及 ready 状态均不显示横幅", () => {
    vi.mocked(useOrchestratorStatus).mockReturnValue(
      status({ attempt: 1, lastError: null, nextRetryAt: null }),
    );
    const view = render(<OrchestratorAlertBanner />);
    expect(view.container).toBeEmptyDOMElement();

    vi.mocked(useOrchestratorStatus).mockReturnValue(
      status({ lifecycle: "ready", port: 47822, attempt: null, lastError: null, nextRetryAt: null }),
    );
    view.rerender(<OrchestratorAlertBanner />);
    expect(view.container).toBeEmptyDOMElement();
  });
});

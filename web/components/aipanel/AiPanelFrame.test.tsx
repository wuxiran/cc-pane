import "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { aiPanelService } from "@/services/aiPanelService";
import type { AiPanel } from "@/types/aiPanel";
import AiPanelFrame from "./AiPanelFrame";

vi.mock("@/services/aiPanelService", () => ({
  aiPanelService: {
    recordEvent: vi.fn(() => Promise.resolve()),
  },
}));

function panel(overrides: Partial<AiPanel> = {}): AiPanel {
  return {
    panelId: "panel-1",
    title: "Progress",
    format: "html",
    content: '<button data-action="approve" data-payload=\'{"id":7}\'>Approve</button>',
    driverName: "Worker A",
    updatedAt: "2026-07-25T10:00:00Z",
    ...overrides,
  };
}

describe("AiPanelFrame", () => {
  beforeEach(() => {
    vi.mocked(aiPanelService.recordEvent).mockClear();
  });

  it("renders markdown through the existing GFM pipeline", () => {
    render(<AiPanelFrame panel={panel({ format: "markdown", content: "# Status\n\n| A | B |\n| - | - |\n| 1 | 2 |" })} />);

    expect(screen.getByRole("heading", { level: 1, name: "Status" })).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("uses a strict sandbox and a srcdoc CSP that blocks external resources", () => {
    render(<AiPanelFrame panel={panel()} />);

    const iframe = screen.getByTitle("Progress");
    expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
    const srcDoc = iframe.getAttribute("srcdoc") ?? "";
    expect(srcDoc).toContain("default-src 'none'");
    expect(srcDoc).toContain("connect-src 'none'");
    expect(srcDoc).toContain("img-src data:");
    expect(srcDoc).toContain("data-action");
    expect(srcDoc).toContain("cc-panes:ai-panel-action");
  });

  it("accepts only matching opaque-origin iframe messages and records the action", async () => {
    render(<AiPanelFrame panel={panel()} />);
    const iframe = screen.getByTitle("Progress") as HTMLIFrameElement;
    const srcDoc = iframe.getAttribute("srcdoc") ?? "";
    const bridgeId = srcDoc.match(/const bridgeId = "([^"]+)"/)?.[1];
    expect(bridgeId).toBeTruthy();

    window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow,
      origin: "null",
      data: {
        type: "cc-panes:ai-panel-action",
        bridgeId,
        action: "approve",
        payload: { id: 7 },
      },
    }));

    await waitFor(() => {
      expect(aiPanelService.recordEvent).toHaveBeenCalledWith(
        "panel-1",
        "approve",
        { id: 7 },
      );
    });

    window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow,
      origin: "https://example.com",
      data: {
        type: "cc-panes:ai-panel-action",
        bridgeId,
        action: "reject",
      },
    }));
    expect(aiPanelService.recordEvent).toHaveBeenCalledTimes(1);
  });
});

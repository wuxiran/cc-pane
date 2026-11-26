import "@/i18n";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ProcessView from "./ProcessView";

// Isolate the wrapper from the heavy ProcessMonitorSection (polling, services).
vi.mock("@/components/sidebar/ProcessMonitorSection", () => ({
  default: () => <div>process-monitor-stub</div>,
}));

describe("ProcessView", () => {
  it("renders the PROCESSES header above the ProcessMonitorSection child", () => {
    render(<ProcessView />);
    expect(screen.getByText("PROCESSES")).toBeVisible();
    expect(screen.getByText("process-monitor-stub")).toBeVisible();
  });
});

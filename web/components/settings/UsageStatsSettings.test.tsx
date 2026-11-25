import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import UsageStatsSettings from "./UsageStatsSettings";

vi.mock("@/components/home/HomeUsageStats", () => ({
  default: () => <div data-testid="home-usage-stats" />,
}));

describe("UsageStatsSettings", () => {
  it("wraps the shared usage stats in a settings section anchor", () => {
    const { container } = render(<UsageStatsSettings />);

    expect(screen.getByTestId("home-usage-stats")).toBeInTheDocument();
    expect(container.querySelector('[data-settings-section="usage-stats-overview"]')).not.toBeNull();
  });
});

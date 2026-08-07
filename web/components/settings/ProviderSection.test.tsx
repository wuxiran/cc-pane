import "@/i18n";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ProviderSection from "./ProviderSection";

vi.mock("@/components/providers", () => ({
  ProvidersPanel: vi.fn(({ compact, view }: { compact?: boolean; view?: string }) => (
    <div data-testid="providers-panel" data-compact={String(compact)} data-view={view} />
  )),
}));

describe("ProviderSection", () => {
  it("renders the requested fixed view in compact mode", () => {
    render(<ProviderSection view="profiles" />);

    const panel = screen.getByTestId("providers-panel");
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveAttribute("data-compact", "true");
    expect(panel).toHaveAttribute("data-view", "profiles");
  });
});

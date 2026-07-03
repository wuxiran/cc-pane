import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { CLI_TOOL_TABS } from "@/types/provider";
import ProviderToolTabs from "./ProviderToolTabs";

const getToolById = vi.fn();

vi.mock("@/hooks/useCliTools", () => ({
  useCliTools: () => ({ getToolById }),
}));

describe("ProviderToolTabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getToolById.mockReturnValue({ installed: true });
  });

  it("renders one button per CLI tool tab", () => {
    render(
      <ProviderToolTabs activeTab="claude" onTabChange={vi.fn()} providerCounts={{}} />
    );
    expect(screen.getAllByRole("button")).toHaveLength(CLI_TOOL_TABS.length);
    expect(
      screen.getByRole("button", { name: i18n.t("settings:tabClaude") })
    ).toBeInTheDocument();
  });

  it("shows count badge only for tabs with providers", () => {
    render(
      <ProviderToolTabs
        activeTab="claude"
        onTabChange={vi.fn()}
        providerCounts={{ claude: 3, codex: 0 }}
      />
    );
    const claudeBtn = screen.getByRole("button", {
      name: new RegExp(i18n.t("settings:tabClaude")),
    });
    expect(claudeBtn.textContent).toContain("3");
    const codexBtn = screen.getByRole("button", {
      name: new RegExp(i18n.t("settings:tabCodex")),
    });
    expect(codexBtn.textContent).not.toContain("0");
  });

  it("marks uninstalled tools with a dot indicator", () => {
    getToolById.mockImplementation((id: string) =>
      id === "claude" ? { installed: true } : { installed: false }
    );
    render(
      <ProviderToolTabs activeTab="claude" onTabChange={vi.fn()} providerCounts={{}} />
    );
    const claudeBtn = screen.getByRole("button", {
      name: new RegExp(i18n.t("settings:tabClaude")),
    });
    expect(claudeBtn.textContent).not.toContain("●");
    const codexBtn = screen.getByRole("button", {
      name: new RegExp(i18n.t("settings:tabCodex")),
    });
    expect(codexBtn.textContent).toContain("●");
  });

  it("treats missing tool info as not installed", () => {
    getToolById.mockReturnValue(undefined);
    render(
      <ProviderToolTabs activeTab="claude" onTabChange={vi.fn()} providerCounts={{}} />
    );
    const claudeBtn = screen.getByRole("button", {
      name: new RegExp(i18n.t("settings:tabClaude")),
    });
    expect(claudeBtn.textContent).toContain("●");
  });

  it("calls onTabChange with the clicked tab id", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    render(
      <ProviderToolTabs activeTab="claude" onTabChange={onTabChange} providerCounts={{}} />
    );
    await user.click(
      screen.getByRole("button", { name: new RegExp(i18n.t("settings:tabKimi")) })
    );
    expect(onTabChange).toHaveBeenCalledWith("kimi");
  });
});

import { render as rtlRender, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CLI_TOOL_TABS } from "@/types/provider";
import ProviderToolTabs from "./ProviderToolTabs";

const getToolById = vi.fn();

vi.mock("@/hooks/useCliTools", () => ({
  useCliTools: () => ({ getToolById }),
}));

const render = (ui: ReactElement) => rtlRender(<TooltipProvider>{ui}</TooltipProvider>);

function tablist() {
  return screen.getByRole("tablist", { name: i18n.t("settings:cliToolSelect") });
}

function tabNamed(label: string) {
  return within(tablist()).getByRole("tab", { name: new RegExp(label) });
}

describe("ProviderToolTabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getToolById.mockReturnValue({ installed: true });
  });

  it("renders every CLI tool as an icon tab, not a dropdown", () => {
    render(
      <ProviderToolTabs activeTab="claude" onTabChange={vi.fn()} providerCounts={{}} />,
    );
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(tablist()).getAllByRole("tab")).toHaveLength(CLI_TOOL_TABS.length);
    expect(tabNamed(i18n.t("settings:tabClaude"))).toHaveAttribute("aria-selected", "true");
    expect(tabNamed(i18n.t("settings:tabCodex"))).toHaveAttribute("aria-selected", "false");
    expect(tablist().querySelector("[data-cli-brand=claude]")).not.toBeNull();
    expect(tablist().querySelector("[data-cli-brand=codex]")).not.toBeNull();
  });

  it("shows counts only for CLI tools with saved items", () => {
    render(
      <ProviderToolTabs
        activeTab="claude"
        onTabChange={vi.fn()}
        providerCounts={{ claude: 3, codex: 0 }}
      />,
    );
    expect(tabNamed(i18n.t("settings:tabClaude"))).toHaveAccessibleName(/3/);
    expect(tabNamed(i18n.t("settings:tabCodex"))).not.toHaveAccessibleName(/0/);
  });

  it("labels uninstalled CLI tools in the accessible name", () => {
    getToolById.mockImplementation((id: string) =>
      id === "claude" ? { installed: true } : { installed: false },
    );
    render(
      <ProviderToolTabs activeTab="claude" onTabChange={vi.fn()} providerCounts={{}} />,
    );
    expect(tabNamed(i18n.t("settings:tabClaude"))).not.toHaveAccessibleName(
      new RegExp(i18n.t("settings:cliNotInstalled")),
    );
    expect(tabNamed(i18n.t("settings:tabCodex"))).toHaveAccessibleName(
      new RegExp(i18n.t("settings:cliNotInstalled")),
    );
  });

  it("treats missing tool info as not installed", () => {
    getToolById.mockReturnValue(undefined);
    render(
      <ProviderToolTabs activeTab="claude" onTabChange={vi.fn()} providerCounts={{}} />,
    );
    expect(tabNamed(i18n.t("settings:tabClaude"))).toHaveAccessibleName(
      new RegExp(i18n.t("settings:cliNotInstalled")),
    );
  });

  it("calls onTabChange with the clicked tab id", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    render(
      <ProviderToolTabs activeTab="claude" onTabChange={onTabChange} providerCounts={{}} />,
    );
    await user.click(tabNamed(i18n.t("settings:tabKimi")));
    expect(onTabChange).toHaveBeenCalledWith("kimi");
  });
});

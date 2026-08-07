import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { CLI_TOOL_TABS } from "@/types/provider";
import ProviderToolTabs from "./ProviderToolTabs";

const getToolById = vi.fn();

vi.mock("@/hooks/useCliTools", () => ({
  useCliTools: () => ({ getToolById }),
}));

async function openToolList(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("combobox", {
    name: i18n.t("settings:cliToolSelect"),
  }));
  return screen.findByRole("listbox");
}

describe("ProviderToolTabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getToolById.mockReturnValue({ installed: true });
  });

  it("renders every CLI tool in a single dropdown", async () => {
    const user = userEvent.setup();
    render(
      <ProviderToolTabs activeTab="claude" onTabChange={vi.fn()} providerCounts={{}} />
    );
    const trigger = screen.getByRole("combobox", {
      name: i18n.t("settings:cliToolSelect"),
    });
    expect(trigger).toHaveTextContent(i18n.t("settings:tabClaude"));

    const listbox = await openToolList(user);
    expect(within(listbox).getAllByRole("option")).toHaveLength(CLI_TOOL_TABS.length);
  });

  it("shows counts only for CLI tools with saved items", async () => {
    const user = userEvent.setup();
    render(
      <ProviderToolTabs
        activeTab="claude"
        onTabChange={vi.fn()}
        providerCounts={{ claude: 3, codex: 0 }}
      />
    );
    const listbox = await openToolList(user);
    const claudeOption = within(listbox).getByRole("option", {
      name: new RegExp(i18n.t("settings:tabClaude")),
    });
    expect(claudeOption).toHaveTextContent("3");
    const codexOption = within(listbox).getByRole("option", {
      name: new RegExp(i18n.t("settings:tabCodex")),
    });
    expect(codexOption).not.toHaveTextContent("0");
  });

  it("labels uninstalled CLI tools in the option list", async () => {
    const user = userEvent.setup();
    getToolById.mockImplementation((id: string) =>
      id === "claude" ? { installed: true } : { installed: false }
    );
    render(
      <ProviderToolTabs activeTab="claude" onTabChange={vi.fn()} providerCounts={{}} />
    );
    const listbox = await openToolList(user);
    const claudeOption = within(listbox).getByRole("option", {
      name: new RegExp(i18n.t("settings:tabClaude")),
    });
    expect(claudeOption).not.toHaveTextContent(i18n.t("settings:cliNotInstalled"));
    const codexOption = within(listbox).getByRole("option", {
      name: new RegExp(i18n.t("settings:tabCodex")),
    });
    expect(codexOption).toHaveTextContent(i18n.t("settings:cliNotInstalled"));
  });

  it("treats missing tool info as not installed", async () => {
    const user = userEvent.setup();
    getToolById.mockReturnValue(undefined);
    render(
      <ProviderToolTabs activeTab="claude" onTabChange={vi.fn()} providerCounts={{}} />
    );
    const listbox = await openToolList(user);
    const claudeOption = within(listbox).getByRole("option", {
      name: new RegExp(i18n.t("settings:tabClaude")),
    });
    expect(claudeOption).toHaveTextContent(i18n.t("settings:cliNotInstalled"));
  });

  it("calls onTabChange with the clicked tab id", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    render(
      <ProviderToolTabs activeTab="claude" onTabChange={onTabChange} providerCounts={{}} />
    );
    const listbox = await openToolList(user);
    await user.click(
      within(listbox).getByRole("option", {
        name: new RegExp(i18n.t("settings:tabKimi")),
      })
    );
    expect(onTabChange).toHaveBeenCalledWith("kimi");
  });
});

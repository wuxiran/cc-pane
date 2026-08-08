import "@/i18n";
import { fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProvidersStore } from "@/stores";
import { mockTauriInvoke } from "@/test/utils/mockTauriInvoke";
import { createTestProvider, resetTestDataCounter } from "@/test/utils/testData";
import type { Provider } from "@/types";
import ProvidersView from "./ProvidersView";

// CLI chips 的未安装点改用 Tooltip（替代原生 title=），测试需要 Provider 环境
const render = (ui: ReactElement) => rtlRender(<TooltipProvider>{ui}</TooltipProvider>);

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const mockInvoke = invoke as ReturnType<typeof vi.fn>;

function setup(providers: Provider[]) {
  mockTauriInvoke({
    list_providers: providers,
    list_cli_tools: [
      {
        id: "claude",
        displayName: "Claude Code",
        executable: "claude",
        versionArgs: [],
        installed: true,
        version: null,
        path: null,
        capabilities: {
          supportsProvider: true,
          supportsResume: true,
          supportsMcp: true,
          supportsSystemPrompt: true,
          supportsWorkspace: true,
          supportsProjectHooks: true,
          compatibleProviderTypes: ["anthropic"],
        },
      },
      {
        id: "codex",
        displayName: "Codex",
        executable: "codex",
        versionArgs: [],
        installed: true,
        version: null,
        path: null,
        capabilities: {
          supportsProvider: true,
          supportsResume: true,
          supportsMcp: true,
          supportsSystemPrompt: true,
          supportsWorkspace: true,
          supportsProjectHooks: true,
          compatibleProviderTypes: ["open_ai"],
        },
      },
    ],
    list_workspaces: [],
    remove_provider: undefined,
    set_default_provider: undefined,
    detect_system_provider: {
      active: false,
      ccSwitch: false,
      envKeys: [],
      defaultIsSystem: providers.some((provider) => provider.isDefault),
      defaultProviderIds: providers.find((provider) => provider.isDefault)
        ? { claude: providers.find((provider) => provider.isDefault)!.id }
        : {},
    },
  });
}

describe("ProvidersView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTestDataCounter();
    useProvidersStore.setState({ providers: [], defaultProviderIds: {} });
  });

  it("renders the Providers header and CLI tool selector", async () => {
    setup([]);
    render(<ProvidersView />);

    expect(screen.getByText(/^(Providers|服务商|供应商)$/i)).toBeVisible();
    const user = userEvent.setup();
    const selector = await screen.findByRole("combobox", { name: /选择 CLI|Select CLI/i });
    expect(selector).toBeVisible();
    await user.click(selector);
    expect(await screen.findByRole("option", { name: /Claude/ })).toBeVisible();
    expect(screen.getByRole("option", { name: /Codex/ })).toBeVisible();
  });

  it("shows the empty placeholder when the active tab has no providers", async () => {
    setup([createTestProvider({ providerType: "open_ai", name: "Codex One" })]);
    render(<ProvidersView />);

    // default tab is claude; the open_ai provider does not match
    await waitFor(() => expect(screen.getByText(/No Providers yet|尚未|暂无/i)).toBeVisible());
  });

  it("lists providers compatible with the active claude tab", async () => {
    setup([
      createTestProvider({ providerType: "anthropic", name: "Claude Main" }),
      createTestProvider({ providerType: "open_ai", name: "Codex Side" }),
    ]);
    render(<ProvidersView />);

    expect(await screen.findByText("Claude Main")).toBeVisible();
    expect(screen.queryByText("Codex Side")).not.toBeInTheDocument();
  });

  it("switches the provider list when selecting a different tool tab", async () => {
    setup([
      createTestProvider({ providerType: "anthropic", name: "Claude Main" }),
      createTestProvider({ providerType: "open_ai", name: "Codex Side" }),
    ]);
    render(<ProvidersView />);

    await screen.findByText("Claude Main");
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: /选择 CLI|Select CLI/i }));
    await user.click(await screen.findByRole("option", { name: /Codex/ }));

    expect(await screen.findByText("Codex Side")).toBeVisible();
    expect(screen.queryByText("Claude Main")).not.toBeInTheDocument();
  });

  it("shows a default badge and hides the star button for the default provider", async () => {
    setup([createTestProvider({ providerType: "anthropic", name: "Claude Main", isDefault: true })]);
    render(<ProvidersView />);

    await screen.findByText("Claude Main");
    expect(screen.getByText(/^Default$|^默认$/i)).toBeVisible();
    expect(screen.queryByTitle(/Set as default|设为默认/i)).not.toBeInTheDocument();
  });

  it("calls set_default_provider when clicking the star on a non-default provider", async () => {
    const provider = createTestProvider({ providerType: "anthropic", name: "Claude Main", isDefault: false });
    setup([provider]);
    render(<ProvidersView />);

    await screen.findByText("Claude Main");
    fireEvent.click(screen.getByTitle(/Set as default|设为默认/i));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("set_default_provider", {
        id: provider.id,
        cliTool: "claude",
      }),
    );
  });

  it("calls remove_provider when clicking the delete button", async () => {
    const provider = createTestProvider({ providerType: "anthropic", name: "Claude Main" });
    setup([provider]);
    render(<ProvidersView />);

    await screen.findByText("Claude Main");
    fireEvent.click(screen.getByTitle(/^Delete$|^删除$/i));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("remove_provider", { id: provider.id }),
    );
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import {
  usePanesStore,
  useProvidersStore,
  useSettingsStore,
  useSshMachinesStore,
  useWorkspacesStore,
} from "@/stores";
import type { Provider } from "@/types/provider";
import ProvidersPanel from "./ProvidersPanel";

// 运行配置面板与 Provider 表单都是重组件，桩掉并回显关键 props
vi.mock("./LaunchProfilesPanel", () => ({
  default: ({ initialTool }: { initialTool?: string }) => (
    <div data-testid="launch-profiles">{initialTool}</div>
  ),
}));

vi.mock("./ProviderFormPanel", () => ({
  default: ({
    editProvider,
    preset,
  }: {
    editProvider?: Provider | null;
    preset?: { id: string } | null;
  }) => (
    <div data-testid="provider-form">
      {editProvider ? `edit:${editProvider.name}` : preset ? `preset:${preset.id}` : "new"}
    </div>
  ),
}));

// 底层 invoke 未按命令 mock 时 listCliTools 会 resolve undefined，桩掉 hook
vi.mock("@/hooks/useCliTools", () => ({
  useCliTools: () => ({
    tools: [],
    loading: false,
    refresh: vi.fn(),
    getToolById: () => ({ installed: true }),
    installedTools: [],
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { toast } = await import("sonner");

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "p-1",
    name: "Claude API",
    providerType: "anthropic",
    apiKey: "sk-ant-1234567890abc",
    baseUrl: null,
    region: null,
    projectId: null,
    awsProfile: null,
    configDir: null,
    isDefault: false,
    ...overrides,
  };
}

function setupStores(providers: Provider[] = []) {
  const actions = {
    loadProviders: vi.fn().mockResolvedValue(undefined),
    removeProvider: vi.fn().mockResolvedValue(undefined),
    setDefault: vi.fn().mockResolvedValue(undefined),
  };
  useProvidersStore.setState({ providers, ...actions });
  usePanesStore.setState({ activePane: () => null } as never);
  useWorkspacesStore.setState({
    workspaces: [],
    selectedWorkspace: () => null,
  } as never);
  useSettingsStore.setState({ settings: null } as never);
  useSshMachinesStore.setState({ machines: [] } as never);
  return actions;
}

async function switchToProvidersList(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Provider 凭证" }));
}

describe("ProvidersPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defaults to the launch-profiles view and loads providers", () => {
    const actions = setupStores();
    render(<ProvidersPanel />);
    expect(screen.getByTestId("launch-profiles")).toHaveTextContent("claude");
    expect(actions.loadProviders).toHaveBeenCalled();
  });

  it("switches to the provider credential list and shows the empty state", async () => {
    const user = userEvent.setup();
    setupStores();
    render(<ProvidersPanel />);
    await switchToProvidersList(user);
    expect(screen.getByText(i18n.t("settings:emptyTitle"))).toBeInTheDocument();
  });

  it("lists providers compatible with the active CLI tab", async () => {
    const user = userEvent.setup();
    setupStores([
      makeProvider(),
      makeProvider({ id: "p-2", name: "Codex API", providerType: "open_ai" }),
    ]);
    render(<ProvidersPanel />);
    await switchToProvidersList(user);

    // claude tab：anthropic 可见，open_ai 不可见
    expect(screen.getByText("Claude API")).toBeInTheDocument();
    expect(screen.queryByText("Codex API")).not.toBeInTheDocument();

    // 切到 codex tab
    await user.click(
      screen.getByRole("button", { name: new RegExp(i18n.t("settings:tabCodex")) })
    );
    expect(screen.getByText("Codex API")).toBeInTheDocument();
    expect(screen.queryByText("Claude API")).not.toBeInTheDocument();
  });

  it("deletes a provider from its card", async () => {
    const user = userEvent.setup();
    const actions = setupStores([makeProvider()]);
    render(<ProvidersPanel />);
    await switchToProvidersList(user);

    await user.click(screen.getByTitle(i18n.t("settings:deleteBtn")));
    await waitFor(() => {
      expect(actions.removeProvider).toHaveBeenCalledWith("p-1");
    });
    expect(toast.success).toHaveBeenCalledWith(i18n.t("settings:providerDeleted"));
  });

  it("sets a provider as default from its card", async () => {
    const user = userEvent.setup();
    const actions = setupStores([makeProvider()]);
    render(<ProvidersPanel />);
    await switchToProvidersList(user);

    await user.click(screen.getByTitle(i18n.t("settings:setAsDefaultBtn")));
    await waitFor(() => {
      expect(actions.setDefault).toHaveBeenCalledWith("p-1");
    });
  });

  it("opens the form pre-filled with a copy when duplicating", async () => {
    const user = userEvent.setup();
    setupStores([makeProvider()]);
    render(<ProvidersPanel />);
    await switchToProvidersList(user);

    await user.click(screen.getByTitle(i18n.t("settings:duplicate")));
    expect(screen.getByTestId("provider-form")).toHaveTextContent(
      "edit:Claude API (Copy)"
    );
    expect(toast.success).toHaveBeenCalledWith(i18n.t("settings:duplicated"));
  });

  it("opens the edit form for an existing provider", async () => {
    const user = userEvent.setup();
    setupStores([makeProvider()]);
    render(<ProvidersPanel />);
    await switchToProvidersList(user);

    await user.click(screen.getByTitle(i18n.t("settings:editBtn")));
    expect(screen.getByTestId("provider-form")).toHaveTextContent("edit:Claude API");
  });

  it("walks the preset-pick flow into the form", async () => {
    const user = userEvent.setup();
    setupStores();
    render(<ProvidersPanel />);
    await switchToProvidersList(user);

    // 空态与头部各有一个"从预设添加"按钮
    await user.click(
      screen.getAllByRole("button", { name: new RegExp(i18n.t("settings:fromPreset")) })[0]
    );
    expect(screen.getByText(i18n.t("settings:selectPresetOrCustom"))).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: new RegExp(i18n.t("settings:manualConfig")) })
    );
    expect(screen.getByTestId("provider-form")).toHaveTextContent("new");
  });

  it("blocks launching without a selected workspace", async () => {
    const user = userEvent.setup();
    setupStores([makeProvider()]);
    render(<ProvidersPanel />);
    await switchToProvidersList(user);

    await user.click(
      screen.getByRole("button", { name: new RegExp(i18n.t("settings:launch")) })
    );
    expect(toast.error).toHaveBeenCalledWith(i18n.t("settings:selectWorkspaceFirst"));
  });
});

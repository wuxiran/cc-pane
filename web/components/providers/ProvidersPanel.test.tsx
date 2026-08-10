import { render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
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
  default: ({ tool, onDirtyChange }: { tool?: string; onDirtyChange?: (dirty: boolean) => void }) => (
    <div data-testid="launch-profiles">
      {tool}
      <button type="button" onClick={() => onDirtyChange?.(true)}>mark-profile-dirty</button>
    </div>
  ),
}));

vi.mock("./ProviderFormPanel", () => ({
  default: ({
    editProvider,
    duplicateSeed,
    preset,
    onBack,
    onSaved,
    onDirtyChange,
  }: {
    editProvider?: Provider | null;
    duplicateSeed?: Provider | null;
    preset?: { id: string } | null;
    onBack?: () => void;
    onSaved?: () => void;
    onDirtyChange?: (dirty: boolean) => void;
  }) => (
    <div data-testid="provider-form">
      {editProvider
        ? `edit:${editProvider.name}`
        : duplicateSeed
          ? `dup:${duplicateSeed.name}`
          : preset
            ? `preset:${preset.id}`
            : "new"}
      <button type="button" onClick={onBack}>form-back</button>
      <button type="button" onClick={onSaved}>form-saved</button>
      <button type="button" onClick={() => onDirtyChange?.(true)}>mark-provider-dirty</button>
    </div>
  ),
}));

// 底层 invoke 未按命令 mock 时 listCliTools 会 resolve undefined，桩掉 hook
vi.mock("@/hooks/useCliTools", () => ({
  useCliTools: () => ({
    tools: [
      {
        id: "claude",
        installed: true,
        capabilities: {
          supportsProvider: true,
          compatibleProviderTypes: ["anthropic", "bedrock", "vertex", "proxy", "config_profile"],
        },
      },
      {
        id: "codex",
        installed: true,
        capabilities: { supportsProvider: true, compatibleProviderTypes: ["open_ai"] },
      },
    ],
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

// 卡片内的 CRUD 图标走统一 IconTooltipButton，需要 TooltipProvider 祖先（生产环境由 AppShell 提供）
const render = (ui: ReactElement) => rtlRender(<TooltipProvider>{ui}</TooltipProvider>);

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
  const claudeDefault = providers.find((provider) => provider.isDefault)?.id;
  const actions = {
    loadProviders: vi.fn().mockResolvedValue(undefined),
    removeProvider: vi.fn().mockResolvedValue(undefined),
    setDefault: vi.fn().mockResolvedValue(undefined),
  };
  useProvidersStore.setState({
    providers,
    systemActive: false,
    systemEnvKeys: [],
    systemCcSwitch: false,
    defaultIsSystem: false,
    defaultProviderIds: claudeDefault ? { claude: claudeDefault } : {},
    ...actions,
  });
  usePanesStore.setState({ activePane: () => null } as never);
  useWorkspacesStore.setState({
    workspaces: [],
    selectedWorkspace: () => null,
  } as never);
  useSettingsStore.setState({ settings: null } as never);
  useSshMachinesStore.setState({ machines: [] } as never);
  return actions;
}

// 子页切换已改为统一 header 的 SegmentedTabs（role=tab）
async function switchToProvidersList(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole("tab", { name: i18n.t("settings:providerCredentialsTab") })
  );
}

async function selectCli(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
) {
  await user.click(screen.getByRole("combobox", {
    name: i18n.t("settings:cliToolSelect"),
  }));
  const listbox = await screen.findByRole("listbox");
  await user.click(within(listbox).getByRole("option", {
    name: new RegExp(label),
  }));
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

  it("pins the credential view without rendering the internal view switcher", () => {
    setupStores();
    render(<ProvidersPanel view="providers" />);

    expect(screen.getByText(i18n.t("settings:systemProviderName"))).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: i18n.t("settings:launchProfilesTab") })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: i18n.t("settings:providerCredentialsTab") })).not.toBeInTheDocument();
  });

  it("does not duplicate the preset creation action in the provider header", () => {
    setupStores([makeProvider()]);
    render(<ProvidersPanel compact view="providers" />);

    expect(screen.queryByRole("button", { name: i18n.t("settings:fromPreset") })).not.toBeInTheDocument();
  });

  it("switches to the provider credential list and shows the empty state", async () => {
    const user = userEvent.setup();
    setupStores();
    render(<ProvidersPanel />);
    await switchToProvidersList(user);
    // 合成「系统环境变量」条目恒置顶，故无真实 provider 时列表非空：
    // 展示 System 条目 + 空态引导文案。
    expect(screen.getByText(i18n.t("settings:systemProviderName"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("settings:emptyDesc"))).toBeInTheDocument();
  });

  it("asks before switching top views when a launch profile is dirty", async () => {
    const user = userEvent.setup();
    setupStores();
    render(<ProvidersPanel />);

    await user.click(screen.getByRole("button", { name: "mark-profile-dirty" }));
    await switchToProvidersList(user);

    expect(screen.getByTestId("launch-profiles")).toBeInTheDocument();
    expect(await screen.findByRole("dialog", { name: i18n.t("common:unsavedChangesTitle") })).toBeVisible();

    await user.click(screen.getByRole("button", { name: i18n.t("common:discardChanges") }));
    expect(screen.getByText(i18n.t("settings:systemProviderName"))).toBeInTheDocument();
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
    await selectCli(user, i18n.t("settings:tabCodex"));
    expect(screen.getByText("Codex API")).toBeInTheDocument();
    expect(screen.queryByText("Claude API")).not.toBeInTheDocument();
  });

  it("shows an independent persisted default for each CLI tab", async () => {
    const user = userEvent.setup();
    setupStores([
      makeProvider({ id: "claude-default", name: "Claude Default" }),
      makeProvider({
        id: "codex-default",
        name: "Codex Default",
        providerType: "open_ai",
      }),
    ]);
    useProvidersStore.setState({
      defaultProviderIds: {
        claude: "claude-default",
        codex: "codex-default",
      },
    });
    render(<ProvidersPanel />);
    await switchToProvidersList(user);

    expect(screen.getByText("Claude Default").closest(".group")).toHaveTextContent(
      i18n.t("settings:defaultBadge"),
    );

    await selectCli(user, i18n.t("settings:tabCodex"));
    expect(screen.getByText("Codex Default").closest(".group")).toHaveTextContent(
      i18n.t("settings:defaultBadge"),
    );
  });

  it("deletes a provider from its card", async () => {
    const user = userEvent.setup();
    const actions = setupStores([makeProvider()]);
    render(<ProvidersPanel />);
    await switchToProvidersList(user);

    await user.click(screen.getByLabelText(i18n.t("settings:deleteBtn")));
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

    // 系统条目恒置顶，也带「设为默认」主操作 → [0] 是系统卡，[1] 才是这个 provider
    const setDefaultButtons = screen.getAllByRole("button", {
      name: i18n.t("settings:setAsDefaultBtn"),
    });
    await user.click(setDefaultButtons[1]);
    await waitFor(() => {
      expect(actions.setDefault).toHaveBeenCalledWith("p-1", "claude");
    });
  });

  it("sets the synthetic system entry as default through the same persisted path", async () => {
    const user = userEvent.setup();
    const actions = setupStores([makeProvider()]);
    render(<ProvidersPanel />);
    await switchToProvidersList(user);

    await user.click(
      screen.getAllByRole("button", { name: i18n.t("settings:setAsDefaultBtn") })[0]
    );
    await waitFor(() => {
      expect(actions.setDefault).toHaveBeenCalledWith("__system__", "claude");
    });
  });

  it("marks the system entry as default from the persisted flag, not a derived guess", async () => {
    const user = userEvent.setup();
    setupStores([makeProvider({ isDefault: true })]);
    // 后端持久化标记为准：即便存在一个 isDefault 的 provider 也不影响该标记的读取
    useProvidersStore.setState({ defaultProviderIds: { claude: "__system__" } });
    render(<ProvidersPanel />);
    await switchToProvidersList(user);

    // 当前标签只认 scoped 映射，旧的 provider.isDefault 不得制造第二个默认标识。
    expect(screen.getAllByText(i18n.t("settings:defaultBadge"))).toHaveLength(1);
  });

  it("opens the form pre-filled with a copy when duplicating", async () => {
    const user = userEvent.setup();
    setupStores([makeProvider()]);
    render(<ProvidersPanel />);
    await switchToProvidersList(user);

    await user.click(screen.getByLabelText(i18n.t("settings:duplicate")));
    // 复制走 duplicateSeed → 标题与表单状态属「新增」语义，避免误落 update 路径。
    expect(screen.getByTestId("provider-form")).toHaveTextContent(
      "dup:Claude API (Copy)"
    );
    expect(toast.success).toHaveBeenCalledWith(i18n.t("settings:duplicated"));
  });

  it("opens the edit form for an existing provider", async () => {
    const user = userEvent.setup();
    setupStores([makeProvider()]);
    render(<ProvidersPanel />);
    await switchToProvidersList(user);

    await user.click(screen.getByLabelText(i18n.t("settings:editBtn")));
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
    expect(screen.getByRole("heading", { name: i18n.t("settings:fromPreset") })).toBeInTheDocument();
    expect(screen.getByText(i18n.t("settings:selectPresetOrCustom"))).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: new RegExp(i18n.t("settings:manualConfig")) })
    );
    expect(screen.getByTestId("provider-form")).toHaveTextContent("new");
  });

  it("returns to the preset picker when backing out of a preset form", async () => {
    const user = userEvent.setup();
    setupStores();
    render(<ProvidersPanel view="providers" />);

    await user.click(screen.getByRole("button", { name: i18n.t("settings:fromPreset") }));
    await user.click(screen.getByRole("button", { name: /Anthropic/ }));
    expect(screen.getByTestId("provider-form")).toHaveTextContent("preset:anthropic_official");

    await user.click(screen.getByRole("button", { name: "form-back" }));
    expect(screen.getByRole("heading", { name: i18n.t("settings:fromPreset") })).toBeInTheDocument();
  });

  it("offers no launch action and points at the global launcher instead", async () => {
    const user = userEvent.setup();
    setupStores([makeProvider()]);
    render(<ProvidersPanel />);
    await switchToProvidersList(user);

    // 本面板退化为纯凭证管理：启动入口只有全局启动器（Ctrl+T）
    expect(
      screen.queryAllByRole("button", { name: new RegExp(i18n.t("settings:launch")) })
    ).toHaveLength(0);
    expect(
      screen.getByText(
        i18n.t("settings:providerLaunchHint", { shortcut: "Ctrl+T" })
      )
    ).toBeInTheDocument();
  });
});

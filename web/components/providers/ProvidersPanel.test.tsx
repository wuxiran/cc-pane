import { render as rtlRender, screen, waitFor } from "@testing-library/react";
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

async function switchToProvidersList(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole("button", { name: i18n.t("settings:providerCredentialsTab") })
  );
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
    // 合成「系统环境变量」条目恒置顶，故无真实 provider 时列表非空：
    // 展示 System 条目 + 空态引导文案。
    expect(screen.getByText(i18n.t("settings:systemProviderName"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("settings:emptyDesc"))).toBeInTheDocument();
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
      expect(actions.setDefault).toHaveBeenCalledWith("p-1");
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
      expect(actions.setDefault).toHaveBeenCalledWith("__system__");
    });
  });

  it("marks the system entry as default from the persisted flag, not a derived guess", async () => {
    const user = userEvent.setup();
    setupStores([makeProvider({ isDefault: true })]);
    // 后端持久化标记为准：即便存在一个 isDefault 的 provider 也不影响该标记的读取
    useProvidersStore.setState({ defaultIsSystem: true });
    render(<ProvidersPanel />);
    await switchToProvidersList(user);

    // 系统卡与该 provider 卡都呈现「默认」状态标识（互斥性由后端保证，前端只如实渲染）
    expect(screen.getAllByText(i18n.t("settings:defaultBadge"))).toHaveLength(2);
  });

  it("opens the form pre-filled with a copy when duplicating", async () => {
    const user = userEvent.setup();
    setupStores([makeProvider()]);
    render(<ProvidersPanel />);
    await switchToProvidersList(user);

    await user.click(screen.getByLabelText(i18n.t("settings:duplicate")));
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
    expect(screen.getByText(i18n.t("settings:selectPresetOrCustom"))).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: new RegExp(i18n.t("settings:manualConfig")) })
    );
    expect(screen.getByTestId("provider-form")).toHaveTextContent("new");
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

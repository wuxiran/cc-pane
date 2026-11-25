import { render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDialogStore, useProvidersStore } from "@/stores";
import type { LoginAccountView, LoginCommand, Provider } from "@/types/provider";
import { translateError } from "@/utils";
import ProviderFormPanel from "../ProviderFormPanel";
import { maskEmail } from "@/utils/maskEmail";

vi.mock("@/components/editor/JsonEditor", () => ({ default: () => null }));

vi.mock("@/services/providerService", () => ({
  providerService: {
    readConfigDirInfo: vi.fn(),
    openPathInExplorer: vi.fn(),
    previewProviderEnv: vi.fn(),
  },
}));

vi.mock("@/services/loginAccountService", () => ({
  loginAccountService: {
    listLoginAccounts: vi.fn(),
    createLoginAccount: vi.fn(),
    getLoginStatus: vi.fn(),
    getLoginCommand: vi.fn(),
    deleteAccount: vi.fn(),
  },
}));

vi.mock("@/services/filesystemService", () => ({
  filesystemService: { readFile: vi.fn(), writeFile: vi.fn() },
}));

vi.mock("@/hooks/useCliTools", () => ({ useCliTools: () => ({ tools: [] }) }));

vi.mock("@/components/ui/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

// 本机桌面主窗口：允许自动开终端；终端本身桩掉，只看提交的命令。
vi.mock("@/services/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/runtime")>()),
  isTauriRuntime: () => true,
}));
vi.mock("@/components/home/installTerminal", () => ({ runCommandInNewTerminal: vi.fn() }));
vi.mock("@/components/home/agentPromptLaunch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/home/agentPromptLaunch")>()),
  resolveDefaultAgentCwd: () => "/work/project",
}));
vi.mock("@/components/home/agentCatalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/home/agentCatalog")>()),
  currentInstallPlatform: () => "mac",
}));

const { toast } = await import("@/components/ui/toast");
const { providerService } = await import("@/services/providerService");
const { loginAccountService } = await import("@/services/loginAccountService");
const { runCommandInNewTerminal } = await import("@/components/home/installTerminal");

const tp = (key: string, options?: Record<string, unknown>) => String(i18n.t(`providers:providerAccounts.${key}` as never, options as never));
const render = (ui: ReactElement) => rtlRender(<TooltipProvider>{ui}</TooltipProvider>);

function setupStore(providers: Provider[] = []) {
  const actions = {
    addProvider: vi.fn().mockResolvedValue(undefined),
    updateProvider: vi.fn().mockResolvedValue(undefined),
  };
  useProvidersStore.setState({ providers, ...actions });
  return actions;
}

function keyProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "p-1",
    name: "Kimi",
    providerType: "anthropic",
    baseUrl: "https://api.moonshot.cn/anthropic",
    endpoints: { anthropic: "https://api.moonshot.cn/anthropic", chat: "https://api.moonshot.cn/v1" },
    isDefault: false,
    accounts: [{ id: "default", name: "工作号", kind: "api_key", secretStorage: "keychain", color: "blue" }],
    defaultAccountId: "default",
    env: [
      { name: "API_TIMEOUT_MS", value: "600000", sensitive: false, storage: "none" },
      { name: "SECRET_TOKEN", value: "", sensitive: true, storage: "keychain" },
    ],
    ...overrides,
  };
}

function loginView(overrides: Partial<LoginAccountView>): LoginAccountView {
  return {
    providerId: "p-1",
    accountId: "claude-a",
    name: "个人号",
    cliTool: "claude",
    isDefaultLogin: false,
    configDir: "/data/login-accounts/claude-a",
    dirManaged: true,
    dirExists: true,
    status: { state: "not_logged_in" },
    ...overrides,
  };
}

const defaultLoginView = loginView({
  accountId: "__default_login__",
  name: "默认登录",
  isDefaultLogin: true,
  configDir: undefined,
  dirManaged: false,
  status: { state: "logged_in", identity: "me@home.dev" },
});

function loginCommand(overrides: Partial<LoginCommand> = {}): LoginCommand {
  return {
    cliTool: "claude",
    command: "/opt/bin/claude",
    args: ["auth", "login"],
    env: { CLAUDE_CONFIG_DIR: "/data/login-accounts/claude-new" },
    envRemove: ["ANTHROPIC_API_KEY"],
    interactive: false,
    executableFound: true,
    ...overrides,
  };
}

const saveButton = () => screen.getByRole("button", { name: i18n.t("common:save") });
const accountRow = (id: string) => screen.getByTestId(`provider-account-row-${id}`);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(providerService.previewProviderEnv).mockResolvedValue([]);
  vi.mocked(loginAccountService.listLoginAccounts).mockResolvedValue([]);
  vi.mocked(runCommandInNewTerminal).mockImplementation(async (open) => {
    open();
    return "sent";
  });
  useDialogStore.setState({ pendingLaunch: null });
});

describe("plain key provider", () => {
  it("keeps the shortest add path: name, address, key, save", async () => {
    const user = userEvent.setup();
    const actions = setupStore();
    render(<ProviderFormPanel activeTab="claude" onBack={vi.fn()} />);

    // 账号节不出现，不需要额外点开什么。
    expect(screen.queryByRole("heading", { name: tp("section.accounts") })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(i18n.t("settings:providerName")), "My Relay");
    await user.type(screen.getByPlaceholderText("https://api.anthropic.com"), "https://relay.dev");
    await user.type(screen.getByPlaceholderText("sk-ant-..."), "sk-new");
    await user.click(saveButton());

    await waitFor(() => expect(actions.addProvider).toHaveBeenCalledTimes(1));
    const payload = actions.addProvider.mock.calls[0][0] as Provider;
    expect(payload).toMatchObject({
      name: "My Relay",
      providerType: "anthropic",
      apiKey: "sk-new",
      baseUrl: "https://relay.dev",
      endpoints: { anthropic: "https://relay.dev", chat: null, responses: null, gemini: null },
      env: [],
    });
    expect(payload.accounts).toBeUndefined();
  });

  it("adds a second key account and makes it the default", async () => {
    const user = userEvent.setup();
    const actions = setupStore([keyProvider()]);
    render(<ProviderFormPanel editProvider={keyProvider()} onBack={vi.fn()} />);

    // 编辑已带账号的供应商：密钥在账号里换，不再有单独的密钥框。
    expect(screen.queryByPlaceholderText("sk-ant-...")).not.toBeInTheDocument();
    expect(within(accountRow("default")).getByText(tp("account.secretState.keychain"))).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: tp("account.addKey") }));
    const name = screen.getByLabelText(tp("account.name"));
    await user.clear(name);
    await user.type(name, "个人号");
    await user.type(screen.getByLabelText(tp("account.secret")), "sk-second");
    const rows = screen.getAllByTestId(/^provider-account-row-key-/);
    expect(rows).toHaveLength(1);
    await user.click(within(rows[0]).getByRole("button", { name: tp("account.setDefault") }));
    await user.click(saveButton());

    await waitFor(() => expect(actions.updateProvider).toHaveBeenCalledTimes(1));
    const payload = actions.updateProvider.mock.calls[0][0] as Provider;
    const newId = payload.accounts?.[1]?.id;
    expect(newId).toMatch(/^key-[0-9a-f]{12}$/);
    expect(payload.accounts).toEqual([
      expect.objectContaining({ id: "default", name: "工作号", kind: "api_key", secret: null, secretStorage: "keychain" }),
      expect.objectContaining({ id: newId, name: "个人号", kind: "api_key", secret: "sk-second", secretStorage: "none" }),
    ]);
    expect(payload.defaultAccountId).toBe(newId);
    expect(payload.apiKey).toBeNull();
    expect(payload.endpoints).toEqual({
      anthropic: "https://api.moonshot.cn/anthropic",
      chat: "https://api.moonshot.cn/v1",
      responses: null,
      gemini: null,
    });
  });
});

describe("environment variables", () => {
  it("never echoes a saved sensitive value and keeps it when left empty", async () => {
    const user = userEvent.setup();
    const actions = setupStore([keyProvider()]);
    render(<ProviderFormPanel editProvider={keyProvider()} onBack={vi.fn()} />);

    const scope = tp("section.env");
    const value = screen.getByLabelText(tp("env.valueAria", { scope, index: 2 }));
    expect(value).toHaveValue("");
    expect(value).toHaveAttribute("placeholder", tp("env.storedPlaceholder"));
    expect(screen.getByLabelText(tp("env.valueAria", { scope, index: 1 }))).toHaveValue("600000");

    await user.click(saveButton());
    await waitFor(() => expect(actions.updateProvider).toHaveBeenCalledTimes(1));
    expect((actions.updateProvider.mock.calls[0][0] as Provider).env).toEqual([
      { name: "API_TIMEOUT_MS", value: "600000", sensitive: false, storage: "none" },
      { name: "SECRET_TOKEN", value: null, sensitive: true, storage: "keychain" },
    ]);
  });

  it("requires the value again after renaming a sensitive variable", async () => {
    const user = userEvent.setup();
    const actions = setupStore([keyProvider()]);
    render(<ProviderFormPanel editProvider={keyProvider()} onBack={vi.fn()} />);

    const scope = tp("section.env");
    const name = screen.getByLabelText(tp("env.nameAria", { scope, index: 2 }));
    await user.clear(name);
    await user.type(name, "SECRET_TOKEN_V2");
    const value = screen.getByLabelText(tp("env.valueAria", { scope, index: 2 }));
    expect(value).toHaveAttribute("placeholder", tp("env.refillPlaceholder"));
    expect(screen.getByText(tp("env.refillHint"))).toBeInTheDocument();

    await user.click(saveButton());
    expect(actions.updateProvider).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      tp("env.problem.needs_refill", { name: "SECRET_TOKEN_V2" }),
      expect.anything(),
    );

    await user.type(value, "new-secret");
    await user.click(saveButton());
    await waitFor(() => expect(actions.updateProvider).toHaveBeenCalledTimes(1));
    expect((actions.updateProvider.mock.calls[0][0] as Provider).env?.[1]).toEqual({
      name: "SECRET_TOKEN_V2",
      value: "new-secret",
      sensitive: true,
      storage: "none",
    });
  });
});

describe("launch env preview", () => {
  it("shows the backend's masked values and marks overrides", async () => {
    vi.mocked(providerService.previewProviderEnv).mockResolvedValue([
      { name: "ANTHROPIC_BASE_URL", value: "https://api.moonshot.cn/anthropic", sensitive: false, layer: "generated", overridesGenerated: false },
      { name: "ANTHROPIC_AUTH_TOKEN", value: "••••", sensitive: true, layer: "generated", overridesGenerated: false },
      { name: "API_TIMEOUT_MS", value: "600000", sensitive: false, layer: "provider", overridesGenerated: true },
    ]);
    setupStore([keyProvider()]);
    render(<ProviderFormPanel editProvider={keyProvider()} activeTab="claude" onBack={vi.fn()} />);

    const preview = screen.getByTestId("provider-env-preview");
    await waitFor(() => expect(preview).toHaveTextContent("ANTHROPIC_AUTH_TOKEN=••••"));
    expect(providerService.previewProviderEnv).toHaveBeenCalledWith("p-1", "default", "claude");
    expect(preview).toHaveTextContent("API_TIMEOUT_MS=600000");
    expect(within(preview).getAllByText(tp("preview.overrides"))).toHaveLength(1);
    expect(preview.textContent).not.toMatch(/sk-/);
  });
});

describe("login accounts", () => {
  it("creates a login account and opens a terminal running the login command", async () => {
    const user = userEvent.setup();
    setupStore([keyProvider()]);
    vi.mocked(loginAccountService.listLoginAccounts).mockResolvedValue([defaultLoginView]);
    vi.mocked(loginAccountService.createLoginAccount).mockResolvedValue(loginView({
      accountId: "claude-new",
      name: "个人号",
      color: "green",
      configDir: "/data/login-accounts/claude-new",
    }));
    vi.mocked(loginAccountService.getLoginCommand).mockResolvedValue(loginCommand());
    render(<ProviderFormPanel editProvider={keyProvider()} onBack={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: tp("account.addLogin") }));
    const dialog = await screen.findByRole("dialog");
    // Anthropic 类型只有一个登录 CLI：不让选。
    expect(within(dialog).queryByRole("radiogroup", { name: tp("newLogin.cli") })).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(tp("account.name")), "个人号");
    await user.click(within(dialog).getByRole("button", { name: tp("newLogin.create") }));

    await waitFor(() => expect(runCommandInNewTerminal).toHaveBeenCalledTimes(1));
    expect(loginAccountService.createLoginAccount).toHaveBeenCalledWith("p-1", {
      cliTool: "claude",
      name: "个人号",
      color: expect.any(String),
    });
    expect(loginAccountService.getLoginCommand).toHaveBeenCalledWith("p-1", "claude-new", "claude");
    const submitted = vi.mocked(runCommandInNewTerminal).mock.calls[0][1];
    expect(submitted).toBe(
      "env -u ANTHROPIC_API_KEY CLAUDE_CONFIG_DIR='/data/login-accounts/claude-new' '/opt/bin/claude' 'auth' 'login'",
    );
    // 普通 shell 标签，开在默认项目目录。
    expect(useDialogStore.getState().pendingLaunch).toMatchObject({ path: "/work/project", cliTool: "none" });
    expect(within(accountRow("claude-new")).getByText(tp("login.state.notLoggedIn"))).toBeInTheDocument();
    // 建了登录账号后，机器上原有的登录显示为「默认登录」。
    expect(within(accountRow("default-login-claude")).getByText(tp("account.defaultLogin"))).toBeInTheDocument();
  });

  it("lets Gemini providers pick the CLI and explains interactive login", async () => {
    const user = userEvent.setup();
    const provider = keyProvider({ providerType: "gemini", endpoints: {}, baseUrl: null });
    setupStore([provider]);
    vi.mocked(loginAccountService.createLoginAccount).mockResolvedValue(loginView({
      accountId: "antigravity-1",
      cliTool: "antigravity",
      name: "备用号",
    }));
    vi.mocked(loginAccountService.getLoginCommand).mockResolvedValue(loginCommand({
      cliTool: "antigravity",
      command: "agy",
      args: ["acp", "--login"],
      env: { GEMINI_HOME: "/data/login-accounts/antigravity-1", SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" },
      envRemove: [],
      interactive: true,
      executableFound: false,
    }));
    render(<ProviderFormPanel editProvider={provider} onBack={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: tp("account.addLogin") }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: tp("cli.antigravity") }));
    await user.type(within(dialog).getByLabelText(tp("account.name")), "备用号");
    await user.click(within(dialog).getByRole("button", { name: tp("newLogin.create") }));

    await waitFor(() => expect(runCommandInNewTerminal).toHaveBeenCalledTimes(1));
    expect(loginAccountService.createLoginAccount).toHaveBeenCalledWith("p-1", expect.objectContaining({ cliTool: "antigravity" }));
    expect(vi.mocked(runCommandInNewTerminal).mock.calls[0][1]).toContain("GEMINI_HOME='/data/login-accounts/antigravity-1'");
    expect(toast.warning).toHaveBeenCalledWith(tp("login.executableMissing", { command: "agy" }), expect.anything());
    expect(toast.info).toHaveBeenCalledWith(tp("login.interactiveHint"), expect.anything());
  });

  it("shows the three login states and rechecks one", async () => {
    const user = userEvent.setup();
    const provider = keyProvider({
      accounts: [
        { id: "default", name: "密钥", kind: "api_key", secretStorage: "keychain" },
        { id: "claude-a", name: "工作号", kind: "login", cliTool: "claude", configDir: "/d/a" },
        { id: "claude-b", name: "个人号", kind: "login", cliTool: "claude", configDir: "/d/b" },
        { id: "claude-c", name: "备用号", kind: "login", cliTool: "claude", configDir: "/d/c" },
      ],
    });
    setupStore([provider]);
    vi.mocked(loginAccountService.listLoginAccounts).mockResolvedValue([
      defaultLoginView,
      loginView({ accountId: "claude-a", status: { state: "logged_in", identity: "work@corp.dev" } }),
      loginView({ accountId: "claude-b", status: { state: "not_logged_in" } }),
      loginView({ accountId: "claude-c", status: { state: "unknown", reason: "keychain_unavailable" } }),
    ]);
    vi.mocked(loginAccountService.getLoginStatus).mockResolvedValue({ state: "logged_in", identity: "me@personal.dev" });
    render(<ProviderFormPanel editProvider={provider} onBack={vi.fn()} />);

    await waitFor(() => expect(within(accountRow("claude-a")).getByText(tp("login.state.loggedInAs", { identity: maskEmail("work@corp.dev") }))).toBeInTheDocument());
    expect(within(accountRow("claude-b")).getByText(tp("login.state.notLoggedIn"))).toBeInTheDocument();
    expect(within(accountRow("claude-c")).getByText(tp("login.state.unknown"))).toBeInTheDocument();
    expect(within(accountRow("default-login-claude")).getByText(tp("login.state.loggedInAs", { identity: maskEmail("me@home.dev") }))).toBeInTheDocument();
    // 默认登录不能改名、不能删。
    expect(within(accountRow("default-login-claude")).queryByRole("button", { name: /删除|Delete/ })).not.toBeInTheDocument();

    await user.click(within(accountRow("claude-b")).getByRole("button", { name: tp("login.recheck") }));
    await waitFor(() => expect(within(accountRow("claude-b")).getByText(tp("login.state.loggedInAs", { identity: maskEmail("me@personal.dev") }))).toBeInTheDocument());
    expect(loginAccountService.getLoginStatus).toHaveBeenCalledWith("p-1", "claude-b", "claude");
  });
});

describe("deleting accounts", () => {
  const twoKeys = () => keyProvider({
    accounts: [
      { id: "default", name: "工作号", kind: "api_key", secretStorage: "keychain" },
      { id: "key-2", name: "个人号", kind: "api_key", secretStorage: "file" },
    ],
  });

  it("confirms a key account deletion and spells out the consequences", async () => {
    const user = userEvent.setup();
    setupStore([twoKeys()]);
    vi.mocked(loginAccountService.deleteAccount).mockResolvedValue({ accountId: "key-2", dirDeleted: false });
    render(<ProviderFormPanel editProvider={twoKeys()} onBack={vi.fn()} />);

    expect(within(accountRow("key-2")).getByText(tp("account.secretState.file"))).toBeInTheDocument();
    await user.click(within(accountRow("key-2")).getByRole("button", { name: tp("account.delete", { name: "个人号" }) }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(tp("remove.consequenceProfiles"))).toBeInTheDocument();
    expect(within(dialog).getByText(tp("remove.consequenceHistory"))).toBeInTheDocument();
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: tp("remove.confirm") }));

    await waitFor(() => expect(loginAccountService.deleteAccount).toHaveBeenCalledWith("p-1", "key-2", false));
    await waitFor(() => expect(screen.queryByTestId("provider-account-row-key-2")).not.toBeInTheDocument());
    expect(toast.success).toHaveBeenCalledWith(tp("remove.done", { name: "个人号" }), expect.anything());
  });

  it("offers to delete a login directory (off by default) and reports external dirs and keychain leftovers", async () => {
    const user = userEvent.setup();
    const provider = keyProvider({
      accounts: [
        { id: "default", name: "密钥", kind: "api_key", secretStorage: "keychain" },
        { id: "claude-a", name: "个人号", kind: "login", cliTool: "claude", configDir: "/ext/claude" },
      ],
    });
    setupStore([provider]);
    vi.mocked(loginAccountService.deleteAccount).mockResolvedValue({
      accountId: "claude-a",
      configDir: "/ext/claude",
      dirDeleted: false,
      dirKeptReason: "external_dir",
      keychainCredentialsMayRemain: true,
      logoutCommand: "env CLAUDE_CONFIG_DIR='/ext/claude' claude auth logout",
    });
    render(<ProviderFormPanel editProvider={provider} onBack={vi.fn()} />);

    await user.click(within(accountRow("claude-a")).getByRole("button", { name: tp("account.delete", { name: "个人号" }) }));
    const dialog = await screen.findByRole("dialog");
    const checkbox = within(dialog).getByRole("checkbox");
    expect(checkbox).not.toBeChecked();
    expect(within(dialog).getByText(tp("remove.deleteDir"))).toBeInTheDocument();
    await user.click(checkbox);
    await user.click(within(dialog).getByRole("button", { name: tp("remove.confirm") }));

    await waitFor(() => expect(loginAccountService.deleteAccount).toHaveBeenCalledWith("p-1", "claude-a", true));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(
      tp("remove.dirKept.external_dir", { dir: "/ext/claude" }),
      expect.anything(),
    ));
    expect(screen.getByText(tp("remove.keychainBody"))).toBeInTheDocument();
    expect(screen.getByTestId("logout-command")).toHaveTextContent("env CLAUDE_CONFIG_DIR='/ext/claude' claude auth logout");
  });

  it("deletes the directory only when asked: unticked sends deleteDir=false", async () => {
    const user = userEvent.setup();
    const provider = keyProvider({
      accounts: [
        { id: "default", name: "密钥", kind: "api_key", secretStorage: "keychain" },
        { id: "claude-a", name: "个人号", kind: "login", cliTool: "claude", configDir: "/d/a" },
      ],
    });
    setupStore([provider]);
    vi.mocked(loginAccountService.deleteAccount).mockResolvedValue({ accountId: "claude-a", dirDeleted: false });
    render(<ProviderFormPanel editProvider={provider} onBack={vi.fn()} />);

    await user.click(within(accountRow("claude-a")).getByRole("button", { name: tp("account.delete", { name: "个人号" }) }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: tp("remove.confirm") }));
    await waitFor(() => expect(loginAccountService.deleteAccount).toHaveBeenCalledWith("p-1", "claude-a", false));
    expect(screen.queryByTestId("logout-command")).not.toBeInTheDocument();
  });

  it("shows the backend's refusal to delete the last account", async () => {
    const user = userEvent.setup();
    setupStore([keyProvider()]);
    const refusal = { code: "PROVIDER_ACCOUNT_LAST", message: "only account", params: { providerId: "p-1", account: "default" } };
    vi.mocked(loginAccountService.deleteAccount).mockRejectedValue(refusal);
    render(<ProviderFormPanel editProvider={keyProvider()} onBack={vi.fn()} />);

    await user.click(within(accountRow("default")).getByRole("button", { name: tp("account.delete", { name: "工作号" }) }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: tp("remove.confirm") }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(translateError(refusal), expect.anything()));
    expect(accountRow("default")).toBeInTheDocument();
  });

  it("removes an unsaved account without asking the backend", async () => {
    const user = userEvent.setup();
    setupStore([keyProvider()]);
    render(<ProviderFormPanel editProvider={keyProvider()} onBack={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: tp("account.addKey") }));
    const row = screen.getAllByTestId(/^provider-account-row-key-/)[0];
    await user.click(within(row).getByRole("button", { name: /^(删除|Delete)/ }));
    expect(screen.queryAllByTestId(/^provider-account-row-key-/)).toHaveLength(0);
    expect(loginAccountService.deleteAccount).not.toHaveBeenCalled();
  });
});

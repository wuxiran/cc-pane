import "@/i18n";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useLaunchProfilesStore, useProvidersStore, useSharedMcpStore, useWorkspacesStore } from "@/stores";
import { mockTauriInvoke, resetTauriInvoke } from "@/test/utils/mockTauriInvoke";
import { createTestWorkspace } from "@/test/utils/testData";
import type { LaunchProfile, LaunchProfileDraft, LaunchProfileResolution, Provider } from "@/types";
import LaunchProfilesPanel from "./LaunchProfilesPanel";
import LaunchProfileWorkspaceAccountRow from "./LaunchProfileWorkspaceAccountRow";

vi.mock("@/components/ui/toast", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

const tp = (key: string) => String(i18n.t(`providers:${key}` as never));

async function selectOption(user: ReturnType<typeof userEvent.setup>, trigger: HTMLElement, optionName: string) {
  await user.click(trigger);
  const listbox = await screen.findByRole("listbox");
  await user.click(within(listbox).getByRole("option", { name: optionName }));
}

const multiAccountProvider: Provider = {
  id: "p-multi",
  name: "Anthropic Relay",
  providerType: "anthropic",
  isDefault: false,
  defaultAccountId: "acc-work",
  accounts: [
    { id: "acc-work", name: "工作号", kind: "api_key", color: "blue" },
    { id: "acc-personal", name: "个人号", kind: "api_key", color: "green" },
  ],
};

const loginAccountProvider: Provider = {
  id: "p-login",
  name: "Anthropic Login",
  providerType: "anthropic",
  isDefault: false,
  defaultAccountId: "acc-key",
  accounts: [
    { id: "acc-key", name: "密钥号", kind: "api_key" },
    { id: "acc-login", name: "登录号", kind: "login", cliTool: "claude" },
  ],
};

const singleAccountProvider: Provider = {
  id: "p-single",
  name: "Single Key",
  providerType: "anthropic",
  isDefault: false,
  accounts: [{ id: "acc-only", name: "默认", kind: "api_key" }],
};

const emptyResolution: LaunchProfileResolution = {
  profileId: null,
  providerId: null,
  providerName: null,
  mcpServers: [],
  skills: [],
  warnings: [],
  degraded: false,
};

function savedProfileFromDraft(draft: LaunchProfileDraft): LaunchProfile {
  return { ...draft, id: "profile-1", name: draft.name ?? "p", createdAt: "2026-05-12T00:00:00Z", updatedAt: "2026-05-12T00:00:00Z" };
}

type InvokeHandlers = Parameters<typeof mockTauriInvoke>[0];

/** 面板挂载时会拉的一圈列表，统一给空值。 */
const baseCommands: InvokeHandlers = {
  list_launch_profiles: [],
  list_workspaces: [],
  get_shared_mcp_status: [],
  list_skill_market_entries: [],
  list_user_skills: [],
  list_external_skills: [],
  list_cli_tools: [],
  preview_launch_profile_resolution: emptyResolution,
};

function renderPanelWith(commands: InvokeHandlers) {
  mockTauriInvoke({ ...baseCommands, ...commands });
  render(<LaunchProfilesPanel initialTool="claude" />);
}

/** 渲染面板并记录保存出去的草稿。 */
function renderPanel() {
  const saved: { draft: LaunchProfileDraft | null } = { draft: null };
  renderPanelWith({
    list_providers: [multiAccountProvider, singleAccountProvider, loginAccountProvider],
    create_launch_profile: (_cmd: string, args?: Record<string, unknown>) => {
      const draft = args?.draft as LaunchProfileDraft;
      saved.draft = draft;
      return savedProfileFromDraft(draft);
    },
  });
  return saved;
}

/** 新建运行配置并切到指定凭据方式。 */
async function startNewProfile(user: ReturnType<typeof userEvent.setup>, kind: "relay" | "oauth" | "cli") {
  await user.click(await screen.findByRole("button", { name: new RegExp(tp("copyAsProfile")) }));
  await user.click(screen.getByRole("tab", { name: tp(`credentialKind.${kind}`) }));
}

const clickSave = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: new RegExp(tp("saveAsProfile")) }));

const relayCombobox = () => screen.getByRole("combobox", { name: tp("credentialKind.relay") });

describe("运行配置 · 账号选择", () => {
  beforeEach(() => {
    resetTauriInvoke();
    useLaunchProfilesStore.setState({ profiles: [], loading: false });
    useProvidersStore.setState({ providers: [] });
    useSharedMcpStore.setState({ servers: [], config: null, loading: false });
    useWorkspacesStore.setState({ workspaces: [], loading: false });
  });

  it("中转站：多密钥账号的供应商逐个列出，保存的草稿带选中的 providerAccountId", async () => {
    const user = userEvent.setup();
    const saved = renderPanel();

    await startNewProfile(user, "relay");
    expect(relayCombobox()).toHaveTextContent("Anthropic Relay · 工作号");
    await selectOption(user, relayCombobox(), "Anthropic Relay · 个人号");
    expect(relayCombobox()).toHaveTextContent("Anthropic Relay · 个人号");
    await clickSave(user);

    await waitFor(() => {
      expect(saved.draft?.providerId).toBe("p-multi");
      expect(saved.draft?.providerAccountId).toBe("acc-personal");
    });
  });

  it("中转站：单账号供应商只列供应商名，保存时显式带 null（字段不丢）", async () => {
    const user = userEvent.setup();
    const saved = renderPanel();

    await startNewProfile(user, "relay");
    await selectOption(user, relayCombobox(), "Single Key");
    expect(screen.queryByRole("combobox", { name: "账号" })).toBeNull();
    await clickSave(user);

    await waitFor(() => expect(saved.draft?.providerId).toBe("p-single"));
    expect(saved.draft).toHaveProperty("providerAccountId", null);
  });

  it("切回 CLI 自带登录：清空供应商，下拉消失", async () => {
    const user = userEvent.setup();
    const saved = renderPanel();

    await startNewProfile(user, "relay");
    await user.click(screen.getByRole("tab", { name: tp("credentialKind.cli") }));
    expect(screen.queryByRole("combobox", { name: tp("credentialKind.relay") })).toBeNull();
    await clickSave(user);

    await waitFor(() => expect(saved.draft).not.toBeNull());
    expect(saved.draft).toHaveProperty("providerId", null);
    expect(saved.draft).toHaveProperty("providerAccountId", null);
  });

  it("从 Magpie 导入：列出条目，已存在的置灰，只导勾选的，导入后进中转站下拉", async () => {
    const user = userEvent.setup();
    const imported: Provider = { id: "p-mag", name: "Mag Relay", providerType: "anthropic", isDefault: false };
    let providers: Provider[] = [singleAccountProvider];
    let importedKeys: string[] | null = null;
    const createdDrafts: LaunchProfileDraft[] = [];
    renderPanelWith({
      list_providers: () => providers,
      preview_external_providers: {
        available: true,
        path: "/home/u/.config/magpie/providers.json",
        candidates: [
          { key: "magpie:mag:anthropic", name: "Mag Relay", providerType: "anthropic", baseUrl: "https://mag", hasKey: true, modelCount: 2, duplicate: false },
          { key: "magpie:old:anthropic", name: "Old Relay", providerType: "anthropic", baseUrl: "https://old", hasKey: true, modelCount: 0, duplicate: true },
          { key: "magpie:gem:gemini", name: "Gem", providerType: "gemini", baseUrl: "https://gem", hasKey: false, modelCount: 0, duplicate: false },
        ],
        skippedEmpty: 0,
        skippedUnsupported: 1,
        unsupportedLogins: 2,
      },
      import_external_providers: (_cmd: string, args?: Record<string, unknown>) => {
        importedKeys = args?.keys as string[];
        providers = [singleAccountProvider, imported];
        return { imported: 1, skippedDuplicate: 0, skippedEmpty: 0, skippedUnsupported: 0 };
      },
      create_launch_profile: (_cmd: string, args?: Record<string, unknown>) => {
        createdDrafts.push(args?.draft as LaunchProfileDraft);
        return savedProfileFromDraft(args?.draft as LaunchProfileDraft);
      },
    });

    await user.click(await screen.findByRole("button", { name: tp("importFromSource.magpie") }));
    const dialog = await screen.findByRole("dialog");
    const oldRow = await within(dialog).findByRole("checkbox", { name: /Old Relay/ });
    expect(oldRow).toBeDisabled();
    // 已存在的要说清在哪个智能体下
    expect(within(dialog).getByTestId("import-duplicate-summary")).toHaveTextContent("Claude 1 条");
    expect(dialog).toHaveTextContent(tp("importDialog.logins").replace("{{count}}", "2"));
    // 默认勾上未导入的两条；取消 Gem，只导 Mag Relay
    await user.click(within(dialog).getByRole("checkbox", { name: /Gem/ }));
    await user.click(within(dialog).getByRole("button", { name: tp("importDialog.submit").replace("{{count}}", "1") }));

    await waitFor(() => expect(importedKeys).toEqual(["magpie:mag:anthropic"]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // 导入的中转站在它的智能体下顺带建一条运行配置
    expect(createdDrafts).toHaveLength(1);
    expect(createdDrafts[0]).toMatchObject({ name: "Mag Relay", providerId: "p-mag", targetTools: ["claude"], isDefault: false });
    await startNewProfile(user, "relay");
    await user.click(relayCombobox());
    expect(within(await screen.findByRole("listbox")).getByRole("option", { name: "Mag Relay" })).toBeInTheDocument();
  });

  it("中转站已导入但没有运行配置：可勾选，只补建运行配置、不重复导入中转站", async () => {
    const user = userEvent.setup();
    const existing: Provider = { id: "p-old", name: "Old Relay", providerType: "open_ai", isDefault: false };
    let importCalled = false;
    const createdDrafts: LaunchProfileDraft[] = [];
    renderPanelWith({
      list_providers: [existing],
      preview_external_providers: {
        available: true,
        path: "/home/u/.cc-switch/cc-switch.db",
        candidates: [
          { key: "cc_switch:open_ai:Old Relay:https://old", name: "Old Relay", providerType: "open_ai", baseUrl: "https://old", hasKey: true, modelCount: 0, duplicate: true },
        ],
        skippedEmpty: 0,
        skippedUnsupported: 0,
        unsupportedLogins: 0,
      },
      import_external_providers: () => {
        importCalled = true;
        return { imported: 0, skippedDuplicate: 0, skippedEmpty: 0, skippedUnsupported: 0 };
      },
      create_launch_profile: (_cmd: string, args?: Record<string, unknown>) => {
        createdDrafts.push(args?.draft as LaunchProfileDraft);
        return savedProfileFromDraft(args?.draft as LaunchProfileDraft);
      },
    });

    await user.click(await screen.findByRole("button", { name: tp("importFromSource.cc_switch") }));
    const dialog = await screen.findByRole("dialog");
    const row = await within(dialog).findByRole("checkbox", { name: /Old Relay/ });
    expect(row).toBeEnabled();
    expect(row).toBeChecked();
    expect(dialog).toHaveTextContent(tp("importDialog.needsProfile"));
    await user.click(within(dialog).getByRole("button", { name: tp("importDialog.submit").replace("{{count}}", "1") }));

    await waitFor(() => expect(createdDrafts).toHaveLength(1));
    expect(importCalled).toBe(false);
    expect(createdDrafts[0]).toMatchObject({ name: "Old Relay", providerId: "p-old", targetTools: ["codex"] });
  });

  it("来源不存在时弹窗说明找不到，导入按钮不可用", async () => {
    const user = userEvent.setup();
    renderPanelWith({
      list_providers: [],
      preview_external_providers: { available: false, path: "/home/u/.cc-switch/cc-switch.db", candidates: [], skippedEmpty: 0, skippedUnsupported: 0, unsupportedLogins: 0 },
    });

    await user.click(await screen.findByRole("button", { name: tp("importFromSource.cc_switch") }));
    expect(await screen.findByTestId("import-source-missing")).toHaveTextContent("/home/u/.cc-switch/cc-switch.db");
    expect(screen.getByRole("button", { name: tp("importDialog.submit").replace("{{count}}", "0") })).toBeDisabled();
  });

  it("OAuth：只列登录账号；选本机登录账号给出远端回落提示，保存时原样保留", async () => {
    const user = userEvent.setup();
    const saved = renderPanel();

    await startNewProfile(user, "oauth");
    await user.click(screen.getByRole("combobox", { name: tp("credentialKind.oauth") }));
    const listbox = await screen.findByRole("listbox");
    // 密钥账号不出现在 OAuth 里
    expect(within(listbox).queryByRole("option", { name: /密钥号/ })).toBeNull();
    await user.click(within(listbox).getByRole("option", { name: "Anthropic Login · 登录号" }));
    expect(screen.getByTestId("profile-account-local-only-hint")).toHaveTextContent(tp("accountLocalOnlyFallback"));
    await clickSave(user);

    await waitFor(() => expect(saved.draft?.providerId).toBe("p-login"));
    expect(saved.draft).toHaveProperty("providerAccountId", "acc-login");
    expect(saved.draft).toHaveProperty("targetRuntime", null);
  });

  it("换中转站后账号回到新供应商的默认账号", async () => {
    const user = userEvent.setup();
    const saved = renderPanel();

    await startNewProfile(user, "relay");
    await selectOption(user, relayCombobox(), "Anthropic Relay · 个人号");
    await selectOption(user, relayCombobox(), "Single Key");
    await clickSave(user);

    await waitFor(() => expect(saved.draft?.providerId).toBe("p-single"));
    expect(saved.draft).toHaveProperty("providerAccountId", null);
  });
});

describe("工作空间默认账号绑定", () => {
  beforeEach(() => {
    resetTauriInvoke();
    useProvidersStore.setState({ providers: [multiAccountProvider, singleAccountProvider] });
  });

  it("工作空间绑了多账号供应商时可选默认账号，走 update_workspace_provider_account 并同步 store", async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    mockTauriInvoke({
      update_workspace_provider_account: (_cmd: string, args?: Record<string, unknown>) => { calls.push(args); },
    });
    const workspace = createTestWorkspace({ name: "corp", providerId: "p-multi" });
    useWorkspacesStore.setState({ workspaces: [workspace] });
    render(<LaunchProfileWorkspaceAccountRow workspace={workspace} />);

    const select = screen.getByRole("combobox", { name: "工作空间默认账号" });
    expect(select).toHaveValue("acc-work");
    await userEvent.selectOptions(select, "acc-personal");

    await waitFor(() => expect(calls).toEqual([{ workspaceName: "corp", accountId: "acc-personal" }]));
    await waitFor(() => expect(useWorkspacesStore.getState().workspaces[0].providerAccountId).toBe("acc-personal"));
  });

  it("单账号供应商或没绑供应商时不出现", () => {
    const { rerender, container } = render(
      <LaunchProfileWorkspaceAccountRow workspace={createTestWorkspace({ providerId: "p-single" })} />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<LaunchProfileWorkspaceAccountRow workspace={createTestWorkspace({})} />);
    expect(container).toBeEmptyDOMElement();
  });
});

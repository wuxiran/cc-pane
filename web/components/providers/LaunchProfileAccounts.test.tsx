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

function renderPanel(onSave: (draft: LaunchProfileDraft) => void) {
  mockTauriInvoke({
    list_launch_profiles: [],
    list_providers: [multiAccountProvider, singleAccountProvider],
    list_workspaces: [],
    get_shared_mcp_status: [],
    list_skill_market_entries: [],
    list_user_skills: [],
    list_external_skills: [],
    list_cli_tools: [],
    preview_launch_profile_resolution: emptyResolution,
    create_launch_profile: (_cmd: string, args?: Record<string, unknown>) => {
      const draft = args?.draft as LaunchProfileDraft;
      onSave(draft);
      return savedProfileFromDraft(draft);
    },
  });
  render(<LaunchProfilesPanel initialTool="claude" />);
}

describe("运行配置 · 账号选择", () => {
  beforeEach(() => {
    resetTauriInvoke();
    useLaunchProfilesStore.setState({ profiles: [], loading: false });
    useProvidersStore.setState({ providers: [] });
    useSharedMcpStore.setState({ servers: [], config: null, loading: false });
    useWorkspacesStore.setState({ workspaces: [], loading: false });
  });

  it("多账号供应商出现账号选择，保存的草稿带选中的 providerAccountId，摘要卡显示账号名", async () => {
    const user = userEvent.setup();
    let savedDraft: LaunchProfileDraft | null = null;
    renderPanel((draft) => { savedDraft = draft; });

    await user.click(await screen.findByRole("button", { name: new RegExp(tp("copyAsProfile")) }));
    await selectOption(user, screen.getByRole("combobox", { name: tp("fieldProvider") }), "Anthropic Relay");
    const accountSelect = await screen.findByRole("combobox", { name: "账号" });
    expect(screen.getByText("账号：工作号（默认）")).toBeInTheDocument();
    await selectOption(user, accountSelect, "个人号");
    expect(screen.getByText("账号：个人号")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: new RegExp(tp("saveAsProfile")) }));

    await waitFor(() => {
      expect(savedDraft?.providerId).toBe("p-multi");
      expect(savedDraft?.providerAccountId).toBe("acc-personal");
    });
  });

  it("单账号供应商不出现账号选择，保存时显式带 null（字段不丢）", async () => {
    const user = userEvent.setup();
    let savedDraft: LaunchProfileDraft | null = null;
    renderPanel((draft) => { savedDraft = draft; });

    await user.click(await screen.findByRole("button", { name: new RegExp(tp("copyAsProfile")) }));
    await selectOption(user, screen.getByRole("combobox", { name: tp("fieldProvider") }), "Single Key");
    expect(screen.queryByRole("combobox", { name: "账号" })).toBeNull();
    await user.click(screen.getByRole("button", { name: new RegExp(tp("saveAsProfile")) }));

    await waitFor(() => expect(savedDraft?.providerId).toBe("p-single"));
    expect(savedDraft).toHaveProperty("providerAccountId", null);
  });

  it("换供应商后账号回到新供应商的默认账号", async () => {
    const user = userEvent.setup();
    let savedDraft: LaunchProfileDraft | null = null;
    renderPanel((draft) => { savedDraft = draft; });

    await user.click(await screen.findByRole("button", { name: new RegExp(tp("copyAsProfile")) }));
    const providerSelect = screen.getByRole("combobox", { name: tp("fieldProvider") });
    await selectOption(user, providerSelect, "Anthropic Relay");
    await selectOption(user, await screen.findByRole("combobox", { name: "账号" }), "个人号");
    await selectOption(user, providerSelect, "Single Key");
    await user.click(screen.getByRole("button", { name: new RegExp(tp("saveAsProfile")) }));

    await waitFor(() => expect(savedDraft?.providerId).toBe("p-single"));
    expect(savedDraft).toHaveProperty("providerAccountId", null);
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

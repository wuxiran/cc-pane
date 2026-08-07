import "@/i18n";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useLaunchProfilesStore, useProvidersStore, useSharedMcpStore, useWorkspacesStore } from "@/stores";
import { createTestWorkspace, createTestWorkspaceProject } from "@/test/utils/testData";
import { mockTauriInvoke, resetTauriInvoke } from "@/test/utils/mockTauriInvoke";
import type { DiscoveredExternalSkill, LaunchProfile, LaunchProfileDraft, LaunchProfileResolution, Provider } from "@/types";
import { defaultLaunchProfileDraft } from "@/types/launch-profile";
import type { SkillMarketEntry } from "@/types/skill";
import LaunchProfilesPanel from "./LaunchProfilesPanel";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

const tp = (key: string, opts?: Record<string, unknown>) =>
  String(i18n.t(`providers:${key}` as never, opts as never));

/** Radix Select 交互：点 trigger 展开 listbox，再点选项（原生 selectOptions 不适用） */
async function selectOption(
  user: ReturnType<typeof userEvent.setup>,
  trigger: HTMLElement,
  optionName: string,
) {
  await user.click(trigger);
  const listbox = await screen.findByRole("listbox");
  await user.click(within(listbox).getByRole("option", { name: optionName }));
}

const externalSkills: DiscoveredExternalSkill[] = [{
  id: "claude:rust-patterns",
  name: "Idiomatic Rust",
  description: "Prefer type-safe Rust",
  source: { kind: "claude" },
  path: "/home/user/.claude/skills/rust-patterns/SKILL.md",
  contentSha256: "abc",
  installedAt: "2026-05-12T00:00:00Z",
}];

const emptyResolution: LaunchProfileResolution = {
  profileId: null,
  profileName: "System Default",
  profileAlias: "系统默认配置",
  providerId: null,
  providerName: null,
  mcpServers: [],
  skills: [],
  warnings: [],
  degraded: false,
};

function savedProfileFromDraft(draft: LaunchProfileDraft): LaunchProfile {
  return {
    ...draft,
    id: "profile-1",
    name: draft.name ?? "Claude 系统默认配置",
    createdAt: "2026-05-12T00:00:00Z",
    updatedAt: "2026-05-12T00:00:00Z",
  };
}

function makeLaunchProfile(
  id: string,
  name: string,
  targetTools: string[] = ["claude"],
): LaunchProfile {
  return {
    ...defaultLaunchProfileDraft(),
    id,
    name,
    alias: name,
    targetTools,
    createdAt: "2026-05-12T00:00:00Z",
    updatedAt: "2026-05-12T00:00:00Z",
  };
}

function renderPanelWithExternalSkills(onSave: (draft: LaunchProfileDraft) => void) {
  mockTauriInvoke({
    list_launch_profiles: [],
    list_providers: [],
    list_workspaces: [],
    get_shared_mcp_status: [],
    list_skill_market_entries: [],
    list_user_skills: [],
    list_external_skills: externalSkills,
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

/** 12 条市场技能：超过 CollapsibleCheckGroup 的 collapseThreshold(8)，默认折叠 */
const marketEntries: SkillMarketEntry[] = Array.from({ length: 12 }, (_, i) => ({
  id: `market-${i}`,
  name: i === 0 ? "Git Flow Helper" : `Market Skill ${i}`,
  description: i === 0 ? "branch and rebase helpers" : `filler ${i}`,
  tags: [],
  version: "1.0.0",
  recommended: false,
}));

function renderPanelWithMarketSkills() {
  mockTauriInvoke({
    list_launch_profiles: [],
    list_providers: [],
    list_workspaces: [],
    get_shared_mcp_status: [],
    list_skill_market_entries: marketEntries,
    list_user_skills: [],
    list_external_skills: [],
    list_cli_tools: [],
    preview_launch_profile_resolution: emptyResolution,
  });

  // 市场技能行带 Tooltip，需 provider 包裹（其余用例不渲染市场组，故无此依赖）
  render(
    <TooltipProvider>
      <LaunchProfilesPanel initialTool="claude" />
    </TooltipProvider>,
  );
}

function renderKimiPanel(onSave: (draft: LaunchProfileDraft) => void) {
  const kimiProvider: Provider = {
    id: "kimi-provider",
    name: "Kimi API",
    providerType: "kimi",
    apiKey: "test-key",
    baseUrl: "https://api.moonshot.cn/v1",
    models: [
      { id: "kimi-k2.5", label: "Kimi K2.5", contextWindowTokens: 1_000_000 },
      { id: "kimi-k2-thinking", label: "Kimi K2 Thinking" },
    ],
    defaultModelId: "kimi-k2.5",
    isDefault: false,
  };

  mockTauriInvoke({
    list_launch_profiles: [],
    list_providers: [kimiProvider],
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

  render(<LaunchProfilesPanel initialTool="kimi" />);
}

function renderCodexPanel(onSave: (draft: LaunchProfileDraft) => void) {
  const codexProvider: Provider = {
    id: "codex-provider",
    name: "Codex API",
    providerType: "open_ai",
    apiKey: "test-key",
    baseUrl: "https://api.openai.com/v1",
    models: [
      { id: "gpt-5.4", label: "GPT 5.4", defaultEffort: "high" },
    ],
    defaultModelId: "gpt-5.4",
    isDefault: false,
  };

  mockTauriInvoke({
    list_launch_profiles: [],
    list_providers: [codexProvider],
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

  render(<LaunchProfilesPanel initialTool="codex" />);
}

describe("LaunchProfilesPanel external skills", () => {
  beforeEach(() => {
    resetTauriInvoke();
    useLaunchProfilesStore.setState({ profiles: [], loading: false });
    useProvidersStore.setState({ providers: [] });
    useSharedMcpStore.setState({ servers: [], config: null, loading: false });
    useWorkspacesStore.setState({ workspaces: [], loading: false });
  });

  it("saves external source include toggles into the skill policy", async () => {
    const user = userEvent.setup();
    let savedDraft: LaunchProfileDraft | null = null;
    renderPanelWithExternalSkills((draft) => {
      savedDraft = draft;
    });

    await screen.findByText("External Skills");
    await user.click(screen.getByRole("checkbox", { name: "Claude" }));
    const saveButtons = screen.getAllByRole("button", { name: new RegExp(tp("saveDefault")) });
    await user.click(saveButtons[saveButtons.length - 1]);

    await waitFor(() => {
      expect(savedDraft?.skillPolicy.includeExternalClaudeSkills).toBe(false);
    });
  });

  it("writes external skill checkbox selection to enabledSkillIds in custom mode", async () => {
    const user = userEvent.setup();
    let savedDraft: LaunchProfileDraft | null = null;
    renderPanelWithExternalSkills((draft) => {
      savedDraft = draft;
    });

    // Skill 卡现为 ui/card（data-slot=card），mode 三连改 SegmentedTabs（role=tab）
    const skillSection = (await screen.findByRole("heading", { name: "Skill" })).closest('[data-slot="card"]');
    expect(skillSection).not.toBeNull();
    await screen.findByText("Idiomatic Rust");
    await user.click(within(skillSection as HTMLElement).getByRole("tab", { name: tp("skillMode.custom") }));
    await user.click(within(skillSection as HTMLElement).getByRole("checkbox", { name: /Idiomatic Rust/ }));
    await user.click(within(skillSection as HTMLElement).getByRole("checkbox", { name: /Idiomatic Rust/ }));
    const saveButtons = screen.getAllByRole("button", { name: new RegExp(tp("saveDefault")) });
    await user.click(saveButtons[saveButtons.length - 1]);

    await waitFor(() => {
      expect(savedDraft?.skillPolicy.mode).toBe("custom");
      expect(savedDraft?.skillPolicy.enabledSkillIds).toContain("claude:rust-patterns");
    });
  });

  it("saves yolo mode on the launch profile draft", async () => {
    const user = userEvent.setup();
    let savedDraft: LaunchProfileDraft | null = null;
    renderPanelWithExternalSkills((draft) => {
      savedDraft = draft;
    });

    // YOLO 从 checkbox 行改为 ui/switch 行（role=switch）
    await screen.findByText("YOLO mode");
    await user.click(screen.getByRole("switch", { name: /YOLO mode/ }));
    // 开启 YOLO 是危险操作，需点"确认开启"二次确认后才写入 draft
    await user.click(await screen.findByRole("button", { name: new RegExp(tp("yoloConfirmBtn")) }));
    const saveButtons = screen.getAllByRole("button", { name: new RegExp(tp("saveDefault")) });
    await user.click(saveButtons[saveButtons.length - 1]);

    await waitFor(() => {
      expect(savedDraft?.yoloMode).toBe(true);
    });
  });

  it("saves a Kimi Provider through the unified profile field", async () => {
    const user = userEvent.setup();
    let savedDraft: LaunchProfileDraft | null = null;
    renderKimiPanel((draft) => {
      savedDraft = draft;
    });

    await user.click(await screen.findByRole("button", { name: new RegExp(tp("copyAsProfile")) }));

    const providerSelect = screen.getByRole("combobox", { name: tp("fieldProvider") });
    expect(providerSelect).not.toBeDisabled();

    await selectOption(user, providerSelect, "Kimi API");
    await selectOption(
      user,
      screen.getByRole("combobox", { name: tp("fieldModel") }),
      "Kimi K2 Thinking (kimi-k2-thinking) - 未配置",
    );
    await user.click(screen.getByRole("button", { name: new RegExp(tp("saveAsProfile")) }));

    await waitFor(() => {
      expect(savedDraft?.providerId).toBe("kimi-provider");
      expect(savedDraft?.modelId).toBe("kimi-k2-thinking");
      expect(savedDraft?.adapterOptions?.kimiConfigMode).toBeUndefined();
    });
  });

  it("shows configured and unknown context windows in Provider model options", async () => {
    const user = userEvent.setup();
    renderKimiPanel(() => {});

    await user.click(await screen.findByRole("button", { name: new RegExp(tp("copyAsProfile")) }));
    await selectOption(user, screen.getByRole("combobox", { name: tp("fieldProvider") }), "Kimi API");

    // 模型下拉逐项标注上下文窗口；未配置窗口的模型显式写「未配置」而不是留白
    await user.click(screen.getByRole("combobox", { name: tp("fieldModel") }));
    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).getByRole("option", {
      name: "Kimi K2.5 (kimi-k2.5) - 1,000,000 tokens",
    })).toBeInTheDocument();
    expect(within(listbox).getByRole("option", {
      name: "Kimi K2 Thinking (kimi-k2-thinking) - 未配置",
    })).toBeInTheDocument();
  });

  it("inherits the model effort by default and saves a profile override", async () => {
    const user = userEvent.setup();
    let savedDraft: LaunchProfileDraft | null = null;
    renderCodexPanel((draft) => {
      savedDraft = draft;
    });

    await user.click(await screen.findByRole("button", { name: new RegExp(tp("copyAsProfile")) }));
    await selectOption(user, screen.getByRole("combobox", { name: tp("fieldProvider") }), "Codex API");

    // 未覆盖时 trigger 显示「沿用模型默认强度（高）」，而非某个具体档位
    const effortSelect = screen.getByRole("combobox", { name: tp("fieldReasoningEffort") });
    expect(effortSelect).toHaveTextContent(
      tp("useModelDefaultEffort", { effort: tp("reasoningEffortLevel.high") }),
    );

    await selectOption(user, effortSelect, tp("reasoningEffortLevel.xhigh"));
    await user.click(screen.getByRole("button", { name: new RegExp(tp("saveAsProfile")) }));

    await waitFor(() => {
      expect(savedDraft?.providerId).toBe("codex-provider");
      expect(savedDraft?.adapterOptions?.effort).toBe("xhigh");
    });
  });

  it("filters skills by query across the market group", async () => {
    const user = userEvent.setup();
    renderPanelWithMarketSkills();

    const skillSection = (await screen.findByRole("heading", { name: "Skill" }))
      .closest('[data-slot="card"]') as HTMLElement;
    await within(skillSection).findByText("Market Skill 3");

    await user.type(
      within(skillSection).getByLabelText(tp("searchSkillPlaceholder")),
      "git",
    );

    // 只裁剪可见行，不改分组计数（forceOpen 的单测见 CollapsibleCheckGroup.test.tsx）
    expect(await within(skillSection).findByText("Git Flow Helper")).toBeInTheDocument();
    expect(within(skillSection).queryByText("Market Skill 3")).not.toBeInTheDocument();
  });

  it("shows the no-match hint when the query matches nothing", async () => {
    const user = userEvent.setup();
    renderPanelWithMarketSkills();

    const skillSection = (await screen.findByRole("heading", { name: "Skill" }))
      .closest('[data-slot="card"]') as HTMLElement;
    await user.type(
      within(skillSection).getByLabelText(tp("searchSkillPlaceholder")),
      "zzz-nothing-matches",
    );

    expect(
      await within(skillSection).findAllByText(tp("searchNoMatch")),
    ).not.toHaveLength(0);
  });

  it("creates a profile from the empty-state action in the list aside", async () => {
    const user = userEvent.setup();
    renderPanelWithMarketSkills();

    // 无运行配置 → 左列表空态，其动作与顶部「复制为运行配置」同一回调
    await user.click(await screen.findByRole("button", { name: tp("listEmptyAction") }));
    expect(await screen.findByRole("button", { name: new RegExp(tp("saveAsProfile")) })).toBeInTheDocument();
  });

  it("switches between all saved profiles and workspace bindings", async () => {
    const user = userEvent.setup();
    const designProfile = makeLaunchProfile("profile-design", "Design Profile");
    const codexProfile = makeLaunchProfile("profile-codex", "Codex Profile", ["codex"]);
    const designWorkspace = createTestWorkspace({
      id: "workspace-design",
      name: "design",
      alias: "Design Workspace",
      launchProfileId: designProfile.id,
      projects: [
        createTestWorkspaceProject({
          id: "project-design",
          launchProfileId: designProfile.id,
        }),
      ],
    });
    const apiWorkspace = createTestWorkspace({
      id: "workspace-api",
      name: "api",
      alias: "API Workspace",
      projects: [],
    });

    mockTauriInvoke({
      list_launch_profiles: [designProfile, codexProfile],
      list_providers: [],
      list_workspaces: [designWorkspace, apiWorkspace],
      get_shared_mcp_status: [],
      list_skill_market_entries: [],
      list_user_skills: [],
      list_external_skills: [],
      list_cli_tools: [],
      preview_launch_profile_resolution: emptyResolution,
    });

    render(<LaunchProfilesPanel initialTool="claude" />);

    expect(await screen.findByText("Design Profile")).toBeInTheDocument();
    expect(screen.queryByText("Codex Profile")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", {
      name: new RegExp(tp("workspaceListTab")),
    }));

    const designWorkspaceRow = (await screen.findByText("Design Workspace")).closest("button");
    expect(designWorkspaceRow).not.toBeNull();
    expect(designWorkspaceRow).toHaveTextContent("Design Profile");
    expect(designWorkspaceRow).toHaveTextContent(
      tp("workspaceProjectBindings", { count: 1 }),
    );
    const apiWorkspaceRow = screen.getByText("API Workspace").closest("button");
    expect(apiWorkspaceRow).not.toBeNull();
    expect(apiWorkspaceRow).toHaveTextContent(
      tp("workspaceUsesDefault", { tool: "Claude" }),
    );

    await user.click(designWorkspaceRow as HTMLElement);
    expect(await screen.findByRole("heading", { name: "Design Profile" })).toBeInTheDocument();
    expect(designWorkspaceRow).toHaveTextContent(tp("currentWorkspace"));
  });
});

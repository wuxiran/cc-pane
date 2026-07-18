import "@/i18n";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useLaunchProfilesStore, useProvidersStore, useSharedMcpStore, useWorkspacesStore } from "@/stores";
import { mockTauriInvoke, resetTauriInvoke } from "@/test/utils/mockTauriInvoke";
import type { DiscoveredExternalSkill, LaunchProfile, LaunchProfileDraft, LaunchProfileResolution, Provider } from "@/types";
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

function renderKimiPanel(onSave: (draft: LaunchProfileDraft) => void) {
  const kimiProvider: Provider = {
    id: "kimi-provider",
    name: "Kimi API",
    providerType: "kimi",
    apiKey: "test-key",
    baseUrl: "https://api.moonshot.cn/v1",
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

    const skillSection = (await screen.findByRole("heading", { name: "Skill" })).closest("section");
    expect(skillSection).not.toBeNull();
    await screen.findByText("Idiomatic Rust");
    await user.click(within(skillSection as HTMLElement).getByRole("button", { name: tp("skillMode.custom") }));
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

    await screen.findByText("YOLO mode");
    await user.click(screen.getByRole("checkbox", { name: /YOLO mode/ }));
    // 开启 YOLO 是危险操作，需点"确认开启"二次确认后才写入 draft
    await user.click(await screen.findByRole("button", { name: new RegExp(tp("yoloConfirmBtn")) }));
    const saveButtons = screen.getAllByRole("button", { name: new RegExp(tp("saveDefault")) });
    await user.click(saveButtons[saveButtons.length - 1]);

    await waitFor(() => {
      expect(savedDraft?.yoloMode).toBe(true);
    });
  });

  it("saves native Kimi config mode and blocks explicit Provider selection", async () => {
    const user = userEvent.setup();
    let savedDraft: LaunchProfileDraft | null = null;
    renderKimiPanel((draft) => {
      savedDraft = draft;
    });

    await user.click(await screen.findByRole("button", { name: new RegExp(tp("copyAsProfile")) }));

    const providerSelect = screen.getByLabelText("Provider") as HTMLSelectElement;
    expect(providerSelect.disabled).toBe(true);
    expect(screen.getByText(new RegExp(tp("kimiManagedHint").split("；")[0]))).toBeTruthy();

    await user.selectOptions(screen.getByLabelText(tp("fieldKimiConfigSource")), "native");
    await user.click(screen.getByRole("button", { name: new RegExp(tp("saveAsProfile")) }));

    await waitFor(() => {
      expect(savedDraft?.providerId).toBeNull();
      expect(savedDraft?.adapterOptions?.kimiConfigMode).toBe("native");
    });
  });
});

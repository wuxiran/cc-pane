import "@/i18n";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useLaunchProfilesStore } from "@/stores/useLaunchProfilesStore";
import { useResourceLibraryStore } from "@/stores/useResourceLibraryStore";
import { SKILLS_CHECKED_AT_KEY, useSkillLibraryStore } from "@/stores/useSkillLibraryStore";
import { useWorkspacesStore } from "@/stores/useWorkspacesStore";
import type { LaunchProfile, LaunchProfileDraft } from "@/types";
import type { LibrarySkill } from "@/types/skillLibrary";
import SkillsLibraryPage from "./SkillsLibraryPage";

const lib = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  probe: vi.fn(),
  install: vi.fn(),
  check: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  found: vi.fn(),
  import: vi.fn(),
}));
vi.mock("@/services/skillLibraryService", () => ({ skillLibraryService: lib }));
vi.mock("@/services/skillService", () => ({
  skillService: {
    listBundledSkills: vi.fn(async () => []),
    listExternalSkills: vi.fn(async () => []),
    listWorkspaceSkills: vi.fn(async () => []),
    listSkillMarketEntries: vi.fn(async () => []),
    listUserSkills: vi.fn(async () => []),
    searchSkillMarket: vi.fn(async () => []),
    describeSkillMarketEntry: vi.fn(async (entry: unknown) => entry),
    installSkillMarketEntry: vi.fn(),
    removeUserSkill: vi.fn(),
    readBundledSkill: vi.fn(async () => null),
    readWorkspaceSkill: vi.fn(async () => null),
  },
}));
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/services/nativeDialog", () => ({ nativeConfirm: confirm }));
const feedback = vi.hoisted(() => ({ toastOk: vi.fn(), toastErr: vi.fn(), toastInfo: vi.fn(), toastWarn: vi.fn() }));
vi.mock("@/lib/feedback", async (importOriginal) => ({ ...(await importOriginal<object>()), ...feedback }));

const profile = {
  id: "p1",
  name: "Main",
  alias: null,
  targetTools: ["claude"],
  targetRuntime: null,
  mcpPolicy: { mode: "default", enabledServerIds: [], disabledServerIds: [], includeCcpanesMcp: true, includeSharedMcp: true },
  skillPolicy: {
    mode: "core", enabledSkillIds: [], disabledSkillIds: [], profileSkills: [], includeProjectSkills: false,
    includeExternalClaudeSkills: true, includeExternalCodexSkills: true, includeExternalPluginSkills: true, target: "session",
  },
  isDefault: true,
} as unknown as LaunchProfile;

function skill(id: string, over: Partial<LibrarySkill> = {}): LibrarySkill {
  return {
    id,
    name: id,
    provenance: { kind: "github", repo: "anthropics/skills", path: `skills/${id}`, treeHash: "h" },
    edited: "no",
    gone: false,
    folderMissing: false,
    dirPath: `/data/skills/user/${id}`,
    installedAt: "2026-11-01",
    ...over,
  };
}

const updateProfile = vi.fn(async (_id: string, _draft: LaunchProfileDraft) => {});

function renderPage() {
  return render(<TooltipProvider><SkillsLibraryPage /></TooltipProvider>);
}

beforeEach(() => {
  for (const fn of Object.values(lib)) fn.mockReset();
  lib.list.mockResolvedValue([]);
  lib.found.mockResolvedValue([]);
  lib.read.mockResolvedValue({ content: "# skill", dirPath: "/d", files: ["SKILL.md"] });
  confirm.mockClear();
  for (const fn of Object.values(feedback)) fn.mockClear();
  updateProfile.mockClear();
  localStorage.setItem(SKILLS_CHECKED_AT_KEY, String(Date.now()));
  useActivityBarStore.setState({ appViewMode: "resources" });
  useResourceLibraryStore.setState({ section: "skills", scope: null });
  useSkillLibraryStore.setState({ skills: [], loaded: false, checks: {}, checking: false });
  useLaunchProfilesStore.setState({ profiles: [profile], load: vi.fn(async () => {}), update: updateProfile } as never);
  useWorkspacesStore.setState({ workspaces: [], load: vi.fn(async () => {}) } as never);
});

describe("SkillsLibraryPage install card", () => {
  it("probes the pasted source, lets you pick candidates and installs the picked ones", async () => {
    const user = userEvent.setup();
    lib.probe.mockResolvedValue({
      probeId: "probe-1",
      source: "anthropics/skills",
      kind: "github",
      candidates: [
        { path: "skills/pdf", name: "pdf", description: "PDF tools", have: false, installAs: "pdf" },
        { path: "skills/docx", name: "docx", have: true, haveAs: "docx", installAs: "docx" },
        { path: "skills/xlsx", name: "xlsx", have: false, installAs: "xlsx-anthropics" },
      ],
      tooBig: [],
    });
    lib.install.mockResolvedValue({ installed: ["pdf"], had: [], skipped: [] });
    renderPage();

    await user.type(screen.getByTestId("skill-install-source"), "anthropics/skills");
    await user.click(screen.getByTestId("skill-install-find"));
    expect(lib.probe).toHaveBeenCalledWith("anthropics/skills");

    const result = await screen.findByTestId("skill-probe-result");
    expect(within(result).getByText("将添加为 xlsx-anthropics")).toBeInTheDocument();
    expect(within(result).getByRole("checkbox", { name: "docx" })).toBeDisabled();
    // 新候选不超过 3 个时默认全选
    expect(screen.getByTestId("skill-install-submit")).toHaveTextContent("安装 2 个技能");
    await user.click(within(result).getByRole("checkbox", { name: "xlsx" }));
    await user.click(screen.getByTestId("skill-install-submit"));

    await waitFor(() => expect(lib.install).toHaveBeenCalledWith("probe-1", ["skills/pdf"]));
    expect(feedback.toastOk).toHaveBeenCalledWith("已安装 1 个技能");
    await waitFor(() => expect(screen.queryByTestId("skill-probe-result")).not.toBeInTheDocument());
  });

  it("shows the probe error inline", async () => {
    const user = userEvent.setup();
    lib.probe.mockRejectedValue(new Error("not a git repository"));
    renderPage();
    await user.type(screen.getByTestId("skill-install-source"), "-oops");
    await user.click(screen.getByTestId("skill-install-find"));
    expect(await screen.findByRole("alert")).toHaveTextContent("not a git repository");
  });
});

describe("SkillsLibraryPage updates", () => {
  it("asks before replacing local changes, and keeping them does nothing", async () => {
    const user = userEvent.setup();
    lib.list.mockResolvedValue([skill("mine", { edited: "yes" })]);
    lib.update.mockResolvedValue({ updated: ["mine"], keptEdited: [], gone: [], failed: [] });
    renderPage();

    const row = await screen.findByTestId("skill-library-row");
    expect(within(row).getByText("本地已改动")).toBeInTheDocument();
    await user.click(within(row).getByTestId("skill-row-update"));
    const dialog = await screen.findByTestId("skill-update-edited-dialog");
    expect(dialog).toHaveTextContent("用上游版本替换你对 mine 的改动？");
    await user.click(within(dialog).getByRole("button", { name: "保留我的" }));
    expect(lib.update).not.toHaveBeenCalled();

    await user.click(within(row).getByTestId("skill-row-update"));
    await user.click(await screen.findByTestId("skill-update-edited-confirm"));
    await waitFor(() => expect(lib.update).toHaveBeenCalledWith(["mine"], true));
    await waitFor(() => expect(screen.queryByTestId("skill-update-edited-dialog")).not.toBeInTheDocument());
  });

  it("updates an unchanged skill without asking", async () => {
    const user = userEvent.setup();
    lib.list.mockResolvedValue([skill("clean")]);
    lib.update.mockResolvedValue({ updated: ["clean"], keptEdited: [], gone: [], failed: [] });
    renderPage();
    await user.click(within(await screen.findByTestId("skill-library-row")).getByTestId("skill-row-update"));
    await waitFor(() => expect(lib.update).toHaveBeenCalledWith(["clean"], false));
    expect(screen.queryByTestId("skill-update-edited-dialog")).not.toBeInTheDocument();
  });

  it("bulk update skips edited skills and names them", async () => {
    const user = userEvent.setup();
    lib.list.mockResolvedValue([skill("clean"), skill("mine", { edited: "yes", name: "Mine" })]);
    lib.check.mockResolvedValue([{ id: "clean", status: "update" }, { id: "mine", status: "update" }]);
    lib.update.mockResolvedValue({ updated: ["clean"], keptEdited: [], gone: [], failed: [] });
    renderPage();

    await user.click(await screen.findByTestId("skill-check-updates"));
    await waitFor(() => expect(lib.check).toHaveBeenCalledWith(undefined));
    await user.click(await screen.findByTestId("skill-update-all"));
    await waitFor(() => expect(lib.update).toHaveBeenCalledWith(["clean"], false));
    expect(feedback.toastInfo).toHaveBeenCalledWith(expect.stringContaining("Mine"));
  });

  it("checks quietly on entry when the last check is older than 12 hours", async () => {
    localStorage.setItem(SKILLS_CHECKED_AT_KEY, String(Date.now() - 13 * 60 * 60 * 1000));
    lib.list.mockResolvedValue([skill("clean")]);
    lib.check.mockResolvedValue([{ id: "clean", status: "update" }]);
    renderPage();
    await waitFor(() => expect(lib.check).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("有更新")).toBeInTheDocument();
    expect(feedback.toastInfo).not.toHaveBeenCalled();
    expect(Number(localStorage.getItem(SKILLS_CHECKED_AT_KEY))).toBeGreaterThan(Date.now() - 60_000);
  });

  it("does not check on entry within 12 hours", async () => {
    lib.list.mockResolvedValue([skill("clean")]);
    renderPage();
    await screen.findByTestId("skill-library-row");
    expect(lib.check).not.toHaveBeenCalled();
  });
});

describe("SkillsLibraryPage clean up", () => {
  it("lists skills removed upstream, marks edited ones and moves them to backups on confirm", async () => {
    const user = userEvent.setup();
    lib.list.mockResolvedValue([
      skill("old", { gone: true }),
      skill("tweaked", { gone: true, edited: "yes" }),
      skill("alive"),
    ]);
    lib.remove.mockResolvedValue({ removed: ["old", "tweaked"], backupDir: "/b" });
    renderPage();

    await user.click(await screen.findByTestId("skill-clean-up"));
    const dialog = await screen.findByTestId("skill-remove-gone-dialog");
    const items = within(screen.getByTestId("skill-remove-gone-list")).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(["old", "tweaked本地已改动"]);
    await user.click(within(dialog).getByTestId("skill-remove-gone-confirm"));
    await waitFor(() => expect(lib.remove).toHaveBeenCalledWith(["old", "tweaked"]));
    expect(useLaunchProfilesStore.getState().load).toHaveBeenCalled();
  });

  it("removes one skill after the native confirm", async () => {
    const user = userEvent.setup();
    lib.list.mockResolvedValue([skill("pdf")]);
    lib.remove.mockResolvedValue({ removed: ["pdf"] });
    renderPage();
    await user.click(within(await screen.findByTestId("skill-library-row")).getByTestId("skill-row-remove"));
    expect(confirm).toHaveBeenCalled();
    await waitFor(() => expect(lib.remove).toHaveBeenCalledWith(["pdf"]));
  });
});

describe("SkillsLibraryPage found skills", () => {
  it("imports one or all skills found in the agents' folders", async () => {
    const user = userEvent.setup();
    lib.found.mockResolvedValue([
      { key: "/home/me/.claude/skills/a", name: "a", dirPath: "/home/me/.claude/skills/a", origin: "claude", isLink: false },
      { key: "/home/me/.agents/skills/b", name: "b", dirPath: "/home/me/.agents/skills/b", origin: "agents", isLink: true, linkTarget: "/src/b", inLibraryAs: "b" },
    ]);
    lib.import.mockResolvedValue({ imported: ["a"], failed: [] });
    renderPage();

    const section = await screen.findByTestId("found-skills-section");
    expect(within(section).getByText("链接自 /src/b")).toBeInTheDocument();
    expect(within(section).getByText("资源库已有同名：b")).toBeInTheDocument();
    await user.click(within(section).getAllByTestId("found-import")[0]);
    await waitFor(() => expect(lib.import).toHaveBeenCalledWith(["/home/me/.claude/skills/a"]));
    expect(feedback.toastOk).toHaveBeenCalledWith("已导入 1 个技能");

    await user.click(within(section).getByTestId("found-import-all"));
    await waitFor(() => expect(lib.import).toHaveBeenLastCalledWith(["/home/me/.claude/skills/a", "/home/me/.agents/skills/b"]));
  });
});

describe("SkillsLibraryPage profile chips", () => {
  it("turns a library skill on for a profile without changing its mode", async () => {
    const user = userEvent.setup();
    lib.list.mockResolvedValue([skill("pdf")]);
    renderPage();
    const row = await screen.findByTestId("skill-library-row");
    const chip = within(row).getByTestId("profile-chip");
    expect(chip).toHaveAttribute("aria-pressed", "false");
    await user.click(chip);
    await waitFor(() => expect(updateProfile).toHaveBeenCalled());
    const [, draft] = updateProfile.mock.calls[0];
    expect(draft.skillPolicy.mode).toBe("core");
    expect(draft.skillPolicy.enabledSkillIds).toEqual(["user:pdf"]);
    expect(within(row).getByRole("status")).toHaveTextContent("下次启动生效");
  });

  it("explains why a profile with skills off can't be toggled", async () => {
    const user = userEvent.setup();
    useLaunchProfilesStore.setState({ profiles: [{ ...profile, skillPolicy: { ...profile.skillPolicy, mode: "disabled" } }] });
    lib.list.mockResolvedValue([skill("pdf")]);
    renderPage();
    const row = await screen.findByTestId("skill-library-row");
    await user.click(within(row).getByTestId("profile-chip"));
    expect(updateProfile).not.toHaveBeenCalled();
    expect(within(row).getByRole("status")).toHaveTextContent("启动档「Main」已关闭技能");
  });

  it("shows builtin skills with per-skill chips", async () => {
    renderPage();
    const group = await screen.findByTestId("skill-builtin-group");
    expect(within(group).getByText("ccpanes-codex")).toBeInTheDocument();
    expect(within(group).getAllByTestId("skill-builtin-row").length).toBeGreaterThan(5);
  });
});

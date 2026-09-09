import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useDescriptionLangStore } from "@/stores/useDescriptionLangStore";
import { useLaunchProfilesStore } from "@/stores/useLaunchProfilesStore";
import { useWorkspacesStore } from "@/stores/useWorkspacesStore";
import { createTestWorkspace } from "@/test/utils/testData";
import type { BundledSkill, LaunchProfile, ProjectSkill, ProjectSkillContent, WorkspaceProjectSkill } from "@/types";
import { defaultLaunchProfileDraft } from "@/types/launch-profile";
import WorkspaceSkillsHub from "./WorkspaceSkillsHub";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const service = vi.hoisted(() => ({
  listWorkspaceSkills: vi.fn(),
  readWorkspaceSkill: vi.fn(),
  saveWorkspaceSkill: vi.fn(),
  deleteWorkspaceSkill: vi.fn(),
  importSkill: vi.fn(),
  listBundledSkills: vi.fn(),
  readBundledSkill: vi.fn(),
  listWorkspaceProjectSkills: vi.fn(),
  listProjectSkillRoots: vi.fn(),
  listProjectSkills: vi.fn(),
  readProjectSkill: vi.fn(),
  saveProjectSkill: vi.fn(),
  deleteProjectSkill: vi.fn(),
  moveProjectSkill: vi.fn(),
  listUserSkills: vi.fn(),
  listExternalSkills: vi.fn(),
  listSkillMarketEntries: vi.fn(),
  searchSkillMarket: vi.fn(),
}));
vi.mock("@/services/skillService", () => ({ skillService: service }));
vi.mock("@/services/providerService", () => ({ providerService: { openPathInExplorer: vi.fn() } }));

const profile: LaunchProfile = {
  id: "profile-1",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...defaultLaunchProfileDraft(),
  name: "Default",
  alias: "Default",
  isDefault: true,
};

const updateProfile = vi.fn().mockResolvedValue(profile);
vi.mock("@/services/launchProfileService", () => ({
  launchProfileService: {
    list: vi.fn().mockResolvedValue([]),
    update: (...args: unknown[]) => updateProfile(...args),
  },
}));

const bundled: BundledSkill[] = [
  {
    name: "ccpanes-launch-task",
    description: "Launch a task",
    descriptions: { "zh-CN": "启动任务", en: "Launch a task" },
  },
  { name: "ccpanes-memory-dual-write", description: "Write memory" },
];

const review: ProjectSkill = {
  id: "workspace::review",
  name: "review",
  description: "Review diffs",
  root: "workspace",
  relDir: "review",
  dirPath: "/ws/skills/review",
  skillMdPath: "/ws/skills/review/SKILL.md",
  fileCount: 1,
  hasScripts: false,
  consumers: ["claude", "codex"],
};

const pdf: ProjectSkill = {
  id: ".claude/skills::pdf",
  name: "pdf",
  description: "Read PDFs",
  root: ".claude/skills",
  relDir: "pdf",
  dirPath: "D:/repos/book/.claude/skills/pdf",
  skillMdPath: "D:/repos/book/.claude/skills/pdf/SKILL.md",
  fileCount: 2,
  hasScripts: true,
  consumers: ["claude", "cursor"],
};

const discovered: WorkspaceProjectSkill = {
  projectPath: "D:/repos/book",
  projectAlias: "cc-book",
  skill: pdf,
};

const pdfContent: ProjectSkillContent = {
  skill: pdf,
  content: "---\nname: pdf\n---\nRead PDFs carefully",
  files: ["SKILL.md"],
};

const bundledContent: ProjectSkillContent = {
  skill: {
    ...review,
    id: "builtin::ccpanes-launch-task",
    name: "ccpanes-launch-task",
    root: "builtin",
    relDir: "ccpanes-launch-task",
  },
  content: "---\nname: ccpanes-launch-task\n---\nLaunch",
  files: ["SKILL.md"],
};

describe("WorkspaceSkillsHub", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.listWorkspaceSkills.mockResolvedValue([]);
    service.listBundledSkills.mockResolvedValue(bundled);
    service.listWorkspaceProjectSkills.mockResolvedValue([discovered]);
    service.listProjectSkillRoots.mockResolvedValue([]);
    service.readBundledSkill.mockResolvedValue(bundledContent);
    service.readProjectSkill.mockResolvedValue(pdfContent);
    service.listUserSkills.mockResolvedValue([]);
    service.listExternalSkills.mockResolvedValue([]);
    service.listSkillMarketEntries.mockResolvedValue([]);
    service.searchSkillMarket.mockResolvedValue([]);
    service.importSkill.mockResolvedValue(review);
    useWorkspacesStore.setState({
      workspaces: [createTestWorkspace({ name: "alpha", launchProfileId: "profile-1" })],
    });
    useLaunchProfilesStore.setState({
      profiles: [profile],
      load: vi.fn().mockResolvedValue(undefined),
      update: updateProfile,
    });
  });

  it("工作空间目录为空时仍列出内置注入和项目技能", async () => {
    render(<WorkspaceSkillsHub workspaceName="alpha" />);
    expect(await screen.findByText("ccpanes-launch-task")).toBeInTheDocument();
    expect(screen.getByText("ccpanes-memory-dual-write")).toBeInTheDocument();
    expect(screen.getByText("pdf")).toBeInTheDocument();
    expect(screen.getByText("cc-book")).toBeInTheDocument();
    expect(screen.getByText(i18n.t("projectSkills:hub.workspaceEmpty"))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t("projectSkills:workspaceEmpty.title"))).not.toBeInTheDocument();
    expect(screen.getAllByTestId("workspace-skill-card").length).toBeGreaterThanOrEqual(3);
    expect(service.listWorkspaceProjectSkills).toHaveBeenCalledWith("alpha");
  });

  it("内置技能介绍按开关切中英，没翻译的回落原文", async () => {
    const user = userEvent.setup();
    useDescriptionLangStore.setState({ preference: "zh-CN" });
    render(<WorkspaceSkillsHub workspaceName="alpha" />);
    expect(await screen.findByText("启动任务")).toBeInTheDocument();
    expect(screen.getByText("Write memory")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "EN" }));
    expect(screen.getByText("Launch a task")).toBeInTheDocument();
    expect(screen.queryByText("启动任务")).not.toBeInTheDocument();
  });

  it("工作空间默认在 SSH 启动时提示工作空间 skills 不会挂进远端会话", async () => {
    useWorkspacesStore.setState({
      workspaces: [
        createTestWorkspace({
          name: "alpha",
          launchProfileId: "profile-1",
          defaultEnvironment: "ssh",
        }),
      ],
    });
    render(<WorkspaceSkillsHub workspaceName="alpha" />);
    await screen.findByText("pdf");
    expect(screen.getByTestId("remote-runtime-notice")).toHaveTextContent("SSH");
  });

  it("WSL 能挂 skills，本机和 WSL 都不显示远端提示", async () => {
    useWorkspacesStore.setState({
      workspaces: [
        createTestWorkspace({ name: "alpha", launchProfileId: "profile-1", cliEnvironmentDefaults: { codex: "wsl" } }),
      ],
    });
    render(<WorkspaceSkillsHub workspaceName="alpha" />);
    await screen.findByText("pdf");
    expect(screen.queryByTestId("remote-runtime-notice")).toBeNull();
  });

  it("搜索同时过滤内置和项目技能", async () => {
    const user = userEvent.setup();
    render(<WorkspaceSkillsHub workspaceName="alpha" />);
    await screen.findByText("pdf");
    await user.type(screen.getByLabelText(i18n.t("projectSkills:hub.searchPlaceholder")), "launch");
    expect(screen.getByText("ccpanes-launch-task")).toBeInTheDocument();
    expect(screen.queryByText("pdf")).not.toBeInTheDocument();
    expect(screen.queryByText("ccpanes-memory-dual-write")).not.toBeInTheDocument();
  });

  it("点项目技能在本页打开编辑器", async () => {
    const user = userEvent.setup();
    render(<WorkspaceSkillsHub workspaceName="alpha" />);
    await user.click(await screen.findByText("pdf"));
    expect(service.readProjectSkill).toHaveBeenCalledWith("D:/repos/book", ".claude/skills", "pdf");
    await waitFor(() =>
      expect((screen.getByLabelText("SKILL.md") as HTMLTextAreaElement).value).toBe(pdfContent.content),
    );
  });

  it("点内置技能只读预览，并可复制到工作空间", async () => {
    const user = userEvent.setup();
    render(<WorkspaceSkillsHub workspaceName="alpha" />);
    await user.click(await screen.findByText("ccpanes-launch-task"));
    expect(service.readBundledSkill).toHaveBeenCalledWith("ccpanes-launch-task");
    expect(screen.getByRole("heading", { name: "ccpanes-launch-task" })).toBeInTheDocument();
    await waitFor(() =>
      expect((screen.getByLabelText("SKILL.md") as HTMLTextAreaElement).readOnly).toBe(true),
    );
    await user.click(screen.getByRole("button", { name: i18n.t("projectSkills:hub.copyToWorkspace") }));
    await waitFor(() =>
      expect(service.importSkill).toHaveBeenCalledWith(
        { kind: "workspace", workspaceName: "alpha" },
        { kind: "bundled", name: "ccpanes-launch-task" },
        { overwrite: false },
      ),
    );
  });
});

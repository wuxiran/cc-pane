import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ProjectSkill, ProjectSkillContent, ProjectSkillRoot } from "@/types";
import ProjectSkillsPanel from "./ProjectSkillsPanel";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const service = vi.hoisted(() => ({
  listProjectSkillRoots: vi.fn(),
  listProjectSkills: vi.fn(),
  readProjectSkill: vi.fn(),
  saveProjectSkill: vi.fn(),
  deleteProjectSkill: vi.fn(),
  moveProjectSkill: vi.fn(),
  importProjectSkill: vi.fn(),
  listUserSkills: vi.fn(),
  listExternalSkills: vi.fn(),
  listSkillMarketEntries: vi.fn(),
  searchSkillMarket: vi.fn(),
}));
vi.mock("@/services/skillService", () => ({ skillService: service }));
vi.mock("@/services/providerService", () => ({ providerService: { openPathInExplorer: vi.fn() } }));

const { toast } = await import("sonner");

const PROJECT = "D:/proj";
const ROOTS: ProjectSkillRoot[] = [
  { root: ".agents/skills", consumers: ["codex", "cursor"], recommended: true },
  { root: ".claude/skills", consumers: ["claude", "cursor"], recommended: true },
];
const pdf: ProjectSkill = {
  id: ".claude/skills::pdf",
  name: "pdf",
  description: "Read PDFs",
  root: ".claude/skills",
  relDir: "pdf",
  dirPath: "D:/proj/.claude/skills/pdf",
  skillMdPath: "D:/proj/.claude/skills/pdf/SKILL.md",
  fileCount: 3,
  hasScripts: true,
  consumers: ["claude", "cursor"],
};
const deploy: ProjectSkill = {
  ...pdf,
  id: ".agents/skills::deploy",
  name: "deploy",
  description: null,
  root: ".agents/skills",
  relDir: "deploy",
  hasScripts: false,
  fileCount: 1,
  consumers: ["codex", "cursor"],
};
const pdfContent: ProjectSkillContent = {
  skill: pdf,
  content: "---\nname: pdf\n---\nRead PDFs carefully",
  files: ["SKILL.md", "scripts/extract.py", "references/A.md"],
};

describe("ProjectSkillsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.listProjectSkillRoots.mockResolvedValue(ROOTS);
    service.listProjectSkills.mockResolvedValue([pdf, deploy]);
    service.readProjectSkill.mockResolvedValue(pdfContent);
    service.saveProjectSkill.mockResolvedValue(pdf);
    service.deleteProjectSkill.mockResolvedValue(true);
    service.listUserSkills.mockResolvedValue([]);
    service.listExternalSkills.mockResolvedValue([]);
    service.listSkillMarketEntries.mockResolvedValue([]);
    service.searchSkillMarket.mockResolvedValue([]);
  });

  it("按根目录分组列出技能并显示 CLI 可见性", async () => {
    render(<ProjectSkillsPanel projectPath={PROJECT} />);
    expect(await screen.findByText("pdf")).toBeInTheDocument();
    expect(screen.getByText("deploy")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: ".claude/skills" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: ".agents/skills" })).toBeInTheDocument();
    expect(screen.getByText(i18n.t("projectSkills:hasScripts"))).toBeInTheDocument();
    expect(service.listProjectSkills).toHaveBeenCalledWith(PROJECT);
  });

  it("点击技能读取 SKILL.md 并展示目录文件", async () => {
    const user = userEvent.setup();
    render(<ProjectSkillsPanel projectPath={PROJECT} />);
    await user.click(await screen.findByText("pdf"));
    expect(service.readProjectSkill).toHaveBeenCalledWith(PROJECT, ".claude/skills", "pdf");
    await waitFor(() =>
      expect((screen.getByLabelText("SKILL.md") as HTMLTextAreaElement).value).toBe(pdfContent.content),
    );
    expect(screen.getByText("scripts/extract.py")).toBeInTheDocument();
  });

  it("新建技能：选目录、校验名字、保存后 toast", async () => {
    const user = userEvent.setup();
    render(<ProjectSkillsPanel projectPath={PROJECT} />);
    await screen.findByText("pdf");
    await user.click(screen.getByRole("button", { name: i18n.t("projectSkills:newSkill") }));

    const nameInput = screen.getByPlaceholderText(i18n.t("projectSkills:editor.namePlaceholder"));
    const saveBtn = screen.getByRole("button", { name: new RegExp(i18n.t("projectSkills:editor.save")) });
    await user.type(nameInput, "Bad Name");
    expect(screen.getByText(i18n.t("projectSkills:editor.nameInvalid"))).toBeInTheDocument();
    expect(saveBtn).toBeDisabled();

    await user.clear(nameInput);
    await user.type(nameInput, "review");
    await user.type(screen.getByLabelText("SKILL.md"), "Review carefully");
    await user.click(saveBtn);

    await waitFor(() =>
      expect(service.saveProjectSkill).toHaveBeenCalledWith(PROJECT, ".claude/skills", "review", "Review carefully"),
    );
    expect(toast.success).toHaveBeenCalledWith(i18n.t("projectSkills:toast.saved", { name: "pdf" }));
  });

  it("删除需要确认，确认后调用后端并 toast", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ProjectSkillsPanel projectPath={PROJECT} />);
    await user.click(await screen.findByText("pdf"));
    await waitFor(() =>
      expect((screen.getByLabelText("SKILL.md") as HTMLTextAreaElement).value).toBe(pdfContent.content),
    );
    await user.click(screen.getByRole("button", { name: i18n.t("projectSkills:editor.delete") }));
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(service.deleteProjectSkill).toHaveBeenCalledWith(PROJECT, ".claude/skills", "pdf"));
    expect(toast.success).toHaveBeenCalledWith(i18n.t("projectSkills:toast.deleted", { name: "pdf" }));
    confirmSpy.mockRestore();
  });

  it("空项目显示空态并可打开导入对话框", async () => {
    service.listProjectSkills.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<ProjectSkillsPanel projectPath={PROJECT} />);
    expect(await screen.findByText(i18n.t("projectSkills:empty.title"))).toBeInTheDocument();
    // 头部图标按钮与空态 CTA 同名，点空态那个
    const importButtons = screen.getAllByRole("button", { name: i18n.t("projectSkills:import") });
    await user.click(importButtons[importButtons.length - 1]);
    expect(await screen.findByText(i18n.t("projectSkills:importDialog.title"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("projectSkills:importDialog.noUserSkills"))).toBeInTheDocument();
  });
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useSkillStore } from "@/stores";
import type { SkillInfo, SkillSummary } from "@/types";
import SkillManager from "./SkillManager";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { toast } = await import("sonner");

const PROJECT = "D:/proj";

const summaries: SkillSummary[] = [
  { name: "deploy", preview: "deploy the app", filePath: "/p/deploy.md" },
  { name: "review", preview: "review code", filePath: "/p/review.md" },
];

function mockActions() {
  const actions = {
    loadSkills: vi.fn().mockResolvedValue(undefined),
    selectSkill: vi.fn().mockResolvedValue(undefined),
    saveSkill: vi.fn().mockResolvedValue(undefined),
    deleteSkill: vi.fn().mockResolvedValue(true),
    clearActiveSkill: vi.fn(),
  };
  useSkillStore.setState(actions);
  return actions;
}

describe("SkillManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSkillStore.setState({
      skills: [],
      activeSkill: null,
      loading: false,
      error: null,
    });
  });

  it("loads skills for the project on mount", () => {
    const actions = mockActions();
    render(<SkillManager projectPath={PROJECT} />);
    expect(actions.loadSkills).toHaveBeenCalledWith(PROJECT);
  });

  it("clears the active skill on unmount", () => {
    const actions = mockActions();
    const { unmount } = render(<SkillManager projectPath={PROJECT} />);
    actions.clearActiveSkill.mockClear();
    unmount();
    expect(actions.clearActiveSkill).toHaveBeenCalled();
  });

  it("shows the empty state when no skills exist", () => {
    mockActions();
    render(<SkillManager projectPath={PROJECT} />);
    expect(screen.getByText(i18n.t("dialogs:noSkills"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("dialogs:selectOrCreateSkill"))).toBeInTheDocument();
  });

  it("shows a loading spinner while loading", () => {
    mockActions();
    useSkillStore.setState({ loading: true });
    render(<SkillManager projectPath={PROJECT} />);
    expect(screen.getByText(i18n.t("common:loading"))).toBeInTheDocument();
  });

  it("lists skills with slash names and previews, and selects on click", async () => {
    const user = userEvent.setup();
    const actions = mockActions();
    useSkillStore.setState({ skills: summaries });
    render(<SkillManager projectPath={PROJECT} />);

    expect(screen.getByText("/deploy")).toBeInTheDocument();
    expect(screen.getByText("review code")).toBeInTheDocument();

    await user.click(screen.getByText("/review"));
    expect(actions.selectSkill).toHaveBeenCalledWith(PROJECT, "review");
  });

  it("renders the editor with the active skill content", () => {
    mockActions();
    const active: SkillInfo = {
      name: "deploy",
      content: "run deploy steps",
      filePath: "/p/deploy.md",
    } as SkillInfo;
    useSkillStore.setState({ skills: summaries, activeSkill: active });
    render(<SkillManager projectPath={PROJECT} />);
    expect(screen.getByDisplayValue("run deploy steps")).toBeInTheDocument();
  });

  it("creates a new skill through the editor and shows a success toast", async () => {
    const user = userEvent.setup();
    const actions = mockActions();
    render(<SkillManager projectPath={PROJECT} />);

    // 点击 + 进入新建模式
    const header = screen.getByText(i18n.t("dialogs:skillTitle")).closest("div")!
      .parentElement as HTMLElement;
    await user.click(header.querySelector("button")!);

    await user.type(
      screen.getByPlaceholderText(i18n.t("dialogs:skillCommandNamePlaceholder")),
      "new-skill"
    );
    await user.click(
      screen.getByRole("button", { name: new RegExp(i18n.t("common:save")) })
    );
    expect(actions.saveSkill).toHaveBeenCalledWith(PROJECT, "new-skill", "");
    expect(toast.success).toHaveBeenCalledWith(i18n.t("notifications:skillSaved"));
  });

  it("shows an error toast when saving fails", async () => {
    const user = userEvent.setup();
    const actions = mockActions();
    actions.saveSkill.mockRejectedValue(new Error("disk full"));
    const active: SkillInfo = {
      name: "deploy",
      content: "x",
      filePath: "/p/deploy.md",
    } as SkillInfo;
    useSkillStore.setState({ activeSkill: active });
    render(<SkillManager projectPath={PROJECT} />);

    await user.click(
      screen.getByRole("button", { name: new RegExp(i18n.t("common:save")) })
    );
    expect(toast.error).toHaveBeenCalled();
  });

  it("deletes a skill from the row action", async () => {
    const user = userEvent.setup();
    const actions = mockActions();
    useSkillStore.setState({ skills: summaries });
    render(<SkillManager projectPath={PROJECT} />);

    const row = screen.getByText("/deploy").closest("div[class*='group']") as HTMLElement;
    const deleteBtn = row.querySelector("button")!;
    await user.click(deleteBtn);
    expect(actions.deleteSkill).toHaveBeenCalledWith(PROJECT, "deploy");
    expect(toast.success).toHaveBeenCalledWith(i18n.t("notifications:skillDeleted"));
    // 删除按钮 stopPropagation，不应触发选中
    expect(actions.selectSkill).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import { useSkillStore } from "./useSkillStore";
import { skillService } from "@/services";
import type { SkillInfo, SkillSummary } from "@/types";

vi.mock("@/services", () => ({
  skillService: {
    listSkills: vi.fn(),
    getSkill: vi.fn(),
    saveSkill: vi.fn(),
    deleteSkill: vi.fn(),
    copySkill: vi.fn(),
  },
}));

const mockSummaries: SkillSummary[] = [
  { name: "skill-a", preview: "Skill A content...", filePath: "/p/a.md" },
  { name: "skill-b", preview: "Skill B content...", filePath: "/p/b.md" },
];

const mockSkillInfo: SkillInfo = {
  name: "skill-a",
  content: "Full content of Skill A",
  filePath: "/p/a.md",
};

describe("useSkillStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSkillStore.setState({
      skills: [],
      projectPath: null,
      activeSkill: null,
      loading: false,
      error: null,
    });
  });

  describe("初始状态", () => {
    it("应该有正确的初始值", () => {
      const state = useSkillStore.getState();
      expect(state.skills).toEqual([]);
      expect(state.projectPath).toBeNull();
      expect(state.activeSkill).toBeNull();
      expect(state.loading).toBe(false);
      expect(state.error).toBeNull();
    });
  });

  describe("loadSkills", () => {
    it("成功时应加载 skill 列表", async () => {
      vi.mocked(skillService.listSkills).mockResolvedValue(mockSummaries);

      await useSkillStore.getState().loadSkills("/project/a");

      const state = useSkillStore.getState();
      expect(state.skills).toEqual(mockSummaries);
      expect(state.projectPath).toBe("/project/a");
      expect(state.loading).toBe(false);
    });

    it("失败时应设置 error", async () => {
      vi.mocked(skillService.listSkills).mockRejectedValue(
        new Error("load failed")
      );

      await useSkillStore.getState().loadSkills("/project/a");

      const state = useSkillStore.getState();
      expect(state.error).toContain("load failed");
      expect(state.loading).toBe(false);
    });
  });

  describe("selectSkill", () => {
    it("成功时应设置 activeSkill", async () => {
      vi.mocked(skillService.getSkill).mockResolvedValue(mockSkillInfo);

      await useSkillStore.getState().selectSkill("/project/a", "skill-a");

      expect(useSkillStore.getState().activeSkill).toEqual(mockSkillInfo);
    });

    it("getSkill 返回 null 时 activeSkill 应为 null", async () => {
      vi.mocked(skillService.getSkill).mockResolvedValue(null);

      await useSkillStore.getState().selectSkill("/project/a", "non-exist");

      expect(useSkillStore.getState().activeSkill).toBeNull();
    });

    it("失败时应设置 error", async () => {
      vi.mocked(skillService.getSkill).mockRejectedValue(
        new Error("get failed")
      );

      await useSkillStore.getState().selectSkill("/project/a", "skill-a");

      expect(useSkillStore.getState().error).toContain("get failed");
    });
  });

  describe("saveSkill", () => {
    it("路径匹配时应刷新列表并更新 activeSkill", async () => {
      useSkillStore.setState({ projectPath: "/project/a" });
      const saved: SkillInfo = {
        name: "skill-new",
        content: "new content",
        filePath: "/p/new.md",
      };
      vi.mocked(skillService.saveSkill).mockResolvedValue(saved);
      vi.mocked(skillService.listSkills).mockResolvedValue([
        ...mockSummaries,
        { name: "skill-new", preview: "new content...", filePath: "/p/new.md" },
      ]);

      const result = await useSkillStore
        .getState()
        .saveSkill("/project/a", "skill-new", "new content");

      expect(result).toEqual(saved);
      expect(skillService.listSkills).toHaveBeenCalledWith("/project/a");
      expect(useSkillStore.getState().activeSkill).toEqual(saved);
      expect(useSkillStore.getState().skills).toHaveLength(3);
    });

    it("路径不匹配时不应刷新列表", async () => {
      useSkillStore.setState({ projectPath: "/project/b" });
      const saved: SkillInfo = {
        name: "skill-new",
        content: "new content",
        filePath: "/p/new.md",
      };
      vi.mocked(skillService.saveSkill).mockResolvedValue(saved);

      await useSkillStore
        .getState()
        .saveSkill("/project/a", "skill-new", "new content");

      expect(skillService.listSkills).not.toHaveBeenCalled();
    });
  });

  describe("deleteSkill", () => {
    it("删除成功且路径匹配时应刷新列表", async () => {
      useSkillStore.setState({
        projectPath: "/project/a",
        activeSkill: mockSkillInfo,
      });
      vi.mocked(skillService.deleteSkill).mockResolvedValue(true);
      vi.mocked(skillService.listSkills).mockResolvedValue([mockSummaries[1]]);

      const result = await useSkillStore
        .getState()
        .deleteSkill("/project/a", "skill-a");

      expect(result).toBe(true);
      expect(useSkillStore.getState().skills).toHaveLength(1);
    });

    it("删除当前活跃的 skill 时应清除 activeSkill", async () => {
      useSkillStore.setState({
        projectPath: "/project/a",
        activeSkill: mockSkillInfo,
      });
      vi.mocked(skillService.deleteSkill).mockResolvedValue(true);
      vi.mocked(skillService.listSkills).mockResolvedValue([mockSummaries[1]]);

      await useSkillStore.getState().deleteSkill("/project/a", "skill-a");

      expect(useSkillStore.getState().activeSkill).toBeNull();
    });

    it("删除非活跃 skill 时不应清除 activeSkill", async () => {
      useSkillStore.setState({
        projectPath: "/project/a",
        activeSkill: mockSkillInfo,
      });
      vi.mocked(skillService.deleteSkill).mockResolvedValue(true);
      vi.mocked(skillService.listSkills).mockResolvedValue([mockSummaries[0]]);

      await useSkillStore.getState().deleteSkill("/project/a", "skill-b");

      expect(useSkillStore.getState().activeSkill).toEqual(mockSkillInfo);
    });

    it("删除返回 false 时不应刷新列表", async () => {
      useSkillStore.setState({ projectPath: "/project/a" });
      vi.mocked(skillService.deleteSkill).mockResolvedValue(false);

      const result = await useSkillStore
        .getState()
        .deleteSkill("/project/a", "skill-a");

      expect(result).toBe(false);
      expect(skillService.listSkills).not.toHaveBeenCalled();
    });
  });

  describe("copySkill", () => {
    it("目标为当前路径时应刷新列表", async () => {
      useSkillStore.setState({ projectPath: "/project/b" });
      const copied: SkillInfo = {
        name: "skill-a",
        content: "copied content",
        filePath: "/pb/a.md",
      };
      vi.mocked(skillService.copySkill).mockResolvedValue(copied);
      vi.mocked(skillService.listSkills).mockResolvedValue([
        { name: "skill-a", preview: "copied...", filePath: "/pb/a.md" },
      ]);

      const result = await useSkillStore
        .getState()
        .copySkill("/project/a", "/project/b", "skill-a");

      expect(result).toEqual(copied);
      expect(skillService.listSkills).toHaveBeenCalledWith("/project/b");
    });

    it("目标非当前路径时不应刷新列表", async () => {
      useSkillStore.setState({ projectPath: "/project/c" });
      const copied: SkillInfo = {
        name: "skill-a",
        content: "copied",
        filePath: "/pb/a.md",
      };
      vi.mocked(skillService.copySkill).mockResolvedValue(copied);

      await useSkillStore
        .getState()
        .copySkill("/project/a", "/project/b", "skill-a");

      expect(skillService.listSkills).not.toHaveBeenCalled();
    });
  });

  describe("clearActiveSkill", () => {
    it("应清除 activeSkill", () => {
      useSkillStore.setState({ activeSkill: mockSkillInfo });

      useSkillStore.getState().clearActiveSkill();

      expect(useSkillStore.getState().activeSkill).toBeNull();
    });
  });

  describe("clear", () => {
    it("应重置所有状态", () => {
      useSkillStore.setState({
        skills: mockSummaries,
        projectPath: "/project/a",
        activeSkill: mockSkillInfo,
        error: "some error",
      });

      useSkillStore.getState().clear();

      const state = useSkillStore.getState();
      expect(state.skills).toEqual([]);
      expect(state.projectPath).toBeNull();
      expect(state.activeSkill).toBeNull();
      expect(state.error).toBeNull();
    });
  });
});

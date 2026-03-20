import { describe, it, expect, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { skillService } from "./skillService";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";
import {
  createTestSkill,
  resetTestDataCounter,
} from "@/test/utils/testData";
import type { SkillInfo } from "@/types";

describe("skillService", () => {
  beforeEach(() => {
    resetTauriInvoke();
    resetTestDataCounter();
  });

  describe("listSkills", () => {
    it("应该调用 list_skills 命令并返回 Skill 摘要列表", async () => {
      const skills = [createTestSkill(), createTestSkill()];
      mockTauriInvoke({ list_skills: skills });

      const result = await skillService.listSkills("/tmp/project");

      expect(invoke).toHaveBeenCalledWith("list_skills", {
        projectPath: "/tmp/project",
      });
      expect(result).toEqual(skills);
    });

    it("应该在无 Skill 时返回空数组", async () => {
      mockTauriInvoke({ list_skills: [] });

      const result = await skillService.listSkills("/tmp/project");

      expect(result).toEqual([]);
    });
  });

  describe("getSkill", () => {
    it("应该调用 get_skill 命令并返回完整 Skill 信息", async () => {
      const skill: SkillInfo = {
        name: "my-skill",
        content: "# My Skill\n\nSome content",
        filePath: "/tmp/project/.ccpanes/skills/my-skill.md",
      };
      mockTauriInvoke({ get_skill: skill });

      const result = await skillService.getSkill("/tmp/project", "my-skill");

      expect(invoke).toHaveBeenCalledWith("get_skill", {
        projectPath: "/tmp/project",
        name: "my-skill",
      });
      expect(result).toEqual(skill);
    });

    it("应该在 Skill 不存在时返回 null", async () => {
      mockTauriInvoke({ get_skill: null });

      const result = await skillService.getSkill("/tmp/project", "non-existent");

      expect(result).toBeNull();
    });
  });

  describe("saveSkill", () => {
    it("应该调用 save_skill 命令并返回保存后的 Skill", async () => {
      const skill: SkillInfo = {
        name: "new-skill",
        content: "# New Skill\n\nContent here",
        filePath: "/tmp/project/.ccpanes/skills/new-skill.md",
      };
      mockTauriInvoke({ save_skill: skill });

      const result = await skillService.saveSkill(
        "/tmp/project",
        "new-skill",
        "# New Skill\n\nContent here",
      );

      expect(invoke).toHaveBeenCalledWith("save_skill", {
        projectPath: "/tmp/project",
        name: "new-skill",
        content: "# New Skill\n\nContent here",
      });
      expect(result).toEqual(skill);
    });
  });

  describe("deleteSkill", () => {
    it("应该调用 delete_skill 命令并返回删除结果", async () => {
      mockTauriInvoke({ delete_skill: true });

      const result = await skillService.deleteSkill("/tmp/project", "my-skill");

      expect(invoke).toHaveBeenCalledWith("delete_skill", {
        projectPath: "/tmp/project",
        name: "my-skill",
      });
      expect(result).toBe(true);
    });

    it("应该在 Skill 不存在时返回 false", async () => {
      mockTauriInvoke({ delete_skill: false });

      const result = await skillService.deleteSkill("/tmp/project", "non-existent");

      expect(result).toBe(false);
    });
  });

  describe("copySkill", () => {
    it("应该调用 copy_skill 命令并返回复制后的 Skill", async () => {
      const skill: SkillInfo = {
        name: "copied-skill",
        content: "# Copied Skill",
        filePath: "/tmp/target/.ccpanes/skills/copied-skill.md",
      };
      mockTauriInvoke({ copy_skill: skill });

      const result = await skillService.copySkill(
        "/tmp/source",
        "/tmp/target",
        "copied-skill",
      );

      expect(invoke).toHaveBeenCalledWith("copy_skill", {
        sourceProject: "/tmp/source",
        targetProject: "/tmp/target",
        name: "copied-skill",
      });
      expect(result).toEqual(skill);
    });
  });
});

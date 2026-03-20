/** Skill 完整信息 */
export interface SkillInfo {
  name: string;
  content: string;
  filePath: string;
}

/** Skill 摘要（列表展示用） */
export interface SkillSummary {
  name: string;
  preview: string;
  filePath: string;
}

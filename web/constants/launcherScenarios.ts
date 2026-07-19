// 启动器场景模板：选择模板 = 一次性覆写 draft 的 appendSystemPrompt / effort / verbose，
// 之后用户手改不回弹（applyScenario 是纯 patch，不做任何响应式同步）。
import type { LauncherDraft } from "@/components/launcher/launcherModel";

export interface LauncherScenario {
  id: "default" | "coding" | "docs" | "architect";
  i18nKey: string;
  appendSystemPrompt?: string;
  chips?: Partial<LauncherDraft>;
}

export const LAUNCHER_SCENARIOS: LauncherScenario[] = [
  {
    id: "default",
    i18nKey: "scenario.default",
  },
  {
    id: "coding",
    i18nKey: "scenario.coding",
    appendSystemPrompt:
      "遵循项目编码规范：小文件小函数、不可变数据优先、错误显式处理不吞掉、输入验证放在系统边界；动手前先通读相关代码，改动后自查类型与测试。",
    chips: { verbose: true },
  },
  {
    id: "docs",
    i18nKey: "scenario.docs",
    appendSystemPrompt:
      "本次任务以文档写作为主：输出结构化 Markdown，先列大纲再成文；行文简洁准确，术语与代码事实保持一致，不虚构未实现的行为。",
  },
  {
    id: "architect",
    i18nKey: "scenario.architect",
    appendSystemPrompt:
      "本次任务以架构规划为主：先分析现状与约束，再输出分阶段实施计划、依赖关系与风险点；未经确认不直接大改代码。",
    chips: { effort: "high" },
  },
];

/** 模板 → draft patch：覆写模板管理的字段（appendSystemPrompt/effort/verbose），chips 再叠加 */
export function applyScenario(scenario: LauncherScenario): Partial<LauncherDraft> {
  return {
    scenarioId: scenario.id,
    appendSystemPrompt: scenario.appendSystemPrompt ?? "",
    effort: undefined,
    verbose: false,
    ...scenario.chips,
  };
}

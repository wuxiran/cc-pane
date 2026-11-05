import { useEffect, useState } from "react";
import { skillService } from "@/services/skillService";
import type { DiscoveredExternalSkill } from "@/types";
import { handleErrorSilent } from "@/utils/errorHandler";

/**
 * CLI 自带技能（~/.claude/skills 等）。启动档切到自定义模式时要把它们展开成显式选择，
 * 所以编辑页仍需要这份列表；逐条开关已移到资源库。
 */
export function useExternalSkills(): DiscoveredExternalSkill[] {
  const [skills, setSkills] = useState<DiscoveredExternalSkill[]>([]);
  useEffect(() => {
    let cancelled = false;
    skillService.listExternalSkills()
      .then((list) => { if (!cancelled) setSkills(list); })
      .catch((error) => handleErrorSilent(error, "list external skills"));
    return () => { cancelled = true; };
  }, []);
  return skills;
}

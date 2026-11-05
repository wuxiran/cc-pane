// 资源库之外、也按启动档生效的技能：CC-Panes 内置（逐条开关）、工作空间技能和 CLI 自带技能（整组开关，条目只读）。
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { EXTERNAL_SKILL_GROUPS } from "@/components/providers/launchProfileHelpers";
import { useDescriptionLang } from "@/hooks/useDescriptionLang";
import { skillService } from "@/services/skillService";
import type { BundledSkill, DiscoveredExternalSkill, ProjectSkill } from "@/types";
import { handleErrorSilent } from "@/utils/errorHandler";
import type { SkillDetailTarget } from "./SkillDetailPanel";
import type { SkillChipRenderer } from "./SkillLibrarySection";
import SkillRow from "./SkillRow";
import { builtinSkillRows, bundledPolicyName } from "./skillLibraryModel";

const EXTERNAL_TITLE_KEY = {
  claude: "skillLibrary.externalClaude",
  codex: "skillLibrary.externalCodex",
  plugin: "skillLibrary.externalPlugin",
} as const;

function GroupCard({
  title,
  hint,
  count,
  chips,
  notice,
  children,
  testId,
}: {
  title: string;
  hint?: string;
  count: number;
  chips?: ReactNode;
  notice?: string | null;
  children: ReactNode;
  testId: string;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="rounded-lg border" style={{ borderColor: "var(--app-border)" }} data-testid={testId}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1.5" style={{ borderColor: "var(--app-border)" }}>
        <span className="text-xs font-medium" style={{ color: "var(--app-text-primary)" }}>{title}</span>
        <span className="text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>{t("skillLibrary.groupCount", { count })}</span>
        {hint && <span className="text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>{hint}</span>}
        <span className="flex-1" />
        {chips}
        {notice && <span role="status" className="basis-full text-[length:var(--text-micro)]" style={{ color: "var(--app-text-secondary)" }}>{notice}</span>}
      </div>
      <div className="divide-y" style={{ borderColor: "var(--app-border)" }}>{children}</div>
    </div>
  );
}

interface SkillBuiltinSectionsProps extends SkillChipRenderer {
  workspaceName: string | null;
  selectedKey: string | null;
  onSelect: (target: SkillDetailTarget) => void;
}

export default function SkillBuiltinSections({ workspaceName, selectedKey, onSelect, chips, notice }: SkillBuiltinSectionsProps) {
  const { t } = useTranslation("settings");
  const { describe } = useDescriptionLang();
  const [bundled, setBundled] = useState<BundledSkill[]>([]);
  const [external, setExternal] = useState<DiscoveredExternalSkill[]>([]);
  const [workspaceSkills, setWorkspaceSkills] = useState<ProjectSkill[]>([]);

  useEffect(() => {
    skillService.listBundledSkills().then(setBundled).catch((error) => handleErrorSilent(error, "list bundled skills"));
    skillService.listExternalSkills().then(setExternal).catch((error) => handleErrorSilent(error, "list external skills"));
  }, []);

  useEffect(() => {
    if (!workspaceName) {
      setWorkspaceSkills([]);
      return;
    }
    let cancelled = false;
    skillService.listWorkspaceSkills(workspaceName)
      .then((list) => { if (!cancelled) setWorkspaceSkills(list); })
      .catch((error) => handleErrorSilent(error, "list workspace skills"));
    return () => { cancelled = true; };
  }, [workspaceName]);

  // 默认核心技能排在前面，其余按后端清单补齐：custom 模式只挂勾选的内置技能，
  // 不列出来就再也打不开。后端清单的名字不带前缀，策略里存的是 `ccpanes-<name>`。
  const builtins = useMemo(() => builtinSkillRows(bundled).map((name) => {
    const info = bundled.find((item) => bundledPolicyName(item.name) === name);
    return { name, description: info ? describe(info.descriptions ?? {}, info.description) || null : null };
  }), [bundled, describe]);

  const externalGroups = EXTERNAL_SKILL_GROUPS.map((group) => ({
    ...group,
    skills: external.filter((skill) => skill.source.kind === group.kind),
  })).filter((group) => group.skills.length > 0);

  return (
    <section className="mb-6 space-y-3" aria-label={t("skillLibrary.builtinTitle")}>
      <GroupCard title={t("skillLibrary.builtinTitle")} hint={t("skillLibrary.builtinHint")} count={builtins.length} testId="skill-builtin-group">
        {builtins.map((skill) => {
          const key = `builtin:${skill.name}`;
          return (
            <SkillRow
              key={skill.name}
              rowKey={skill.name}
              name={skill.name}
              description={skill.description}
              current={selectedKey === key}
              onSelect={() => onSelect({ kind: "builtin", key, name: skill.name, description: skill.description })}
              notice={notice(key)}
              trailing={chips(key, skill.name, { kind: "builtin", name: skill.name })}
              testId="skill-builtin-row"
            />
          );
        })}
      </GroupCard>

      {workspaceName && (
        <GroupCard
          title={t("skillLibrary.workspaceTitle", { name: workspaceName })}
          hint={t("skillLibrary.readOnlyHint")}
          count={workspaceSkills.length}
          chips={chips("group:includeWorkspaceSkills", t("skillLibrary.workspaceTitle", { name: workspaceName }), { kind: "group", key: "includeWorkspaceSkills" })}
          notice={notice("group:includeWorkspaceSkills")}
          testId="skill-workspace-group"
        >
          {workspaceSkills.length === 0 ? (
            <p className="px-3 py-3 text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("skillLibrary.workspaceEmpty")}</p>
          ) : workspaceSkills.map((skill) => {
            const key = `ws:${skill.relDir}`;
            return (
              <SkillRow
                key={skill.id}
                rowKey={skill.relDir}
                name={skill.name}
                description={skill.description}
                current={selectedKey === key}
                onSelect={() => onSelect({ kind: "workspace", key, workspaceName, skill })}
                testId="skill-workspace-row"
              />
            );
          })}
        </GroupCard>
      )}

      {externalGroups.map((group) => {
        const groupKey = `group:${group.policyKey}`;
        const title = t(EXTERNAL_TITLE_KEY[group.kind]);
        return (
          <GroupCard
            key={group.kind}
            title={title}
            hint={t("skillLibrary.readOnlyHint")}
            count={group.skills.length}
            chips={chips(groupKey, title, { kind: "group", key: group.policyKey })}
            notice={notice(groupKey)}
            testId="skill-external-group"
          >
            {group.skills.map((skill) => {
              const key = `ext:${skill.id}`;
              return (
                <SkillRow
                  key={skill.id}
                  rowKey={skill.id}
                  name={skill.name}
                  description={skill.description}
                  current={selectedKey === key}
                  onSelect={() => onSelect({ kind: "external", key, skill })}
                  testId="skill-external-row"
                />
              );
            })}
          </GroupCard>
        );
      })}
    </section>
  );
}

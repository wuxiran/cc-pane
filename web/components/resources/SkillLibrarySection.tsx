// 「资源库中」：工具条（筛选、检查更新、更新 N 个）+ 按来源分组的卡片，组头显示数量和「清理 N 个」。
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpCircle, ExternalLink, Loader2, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { Input } from "@/components/ui/input";
import type { LibrarySkill, SkillCheck } from "@/types/skillLibrary";
import { openExternalUrl } from "./libraryChrome";
import type { ProfileSkillResource } from "./resourceCenterModel";
import {
  filterLibrarySkills,
  groupLibrarySkills,
  isGone,
  isTracked,
  skillSourceText,
  skillStatusTags,
  type LibrarySkillGroup,
  type SkillStatusTag,
} from "./skillLibraryModel";
import SkillRow, { type SkillRowTag, type SkillTagTone } from "./SkillRow";
import type { useSkillLibraryActions } from "./useSkillLibraryActions";

const SEARCH_THRESHOLD = 8;

const TAG_TONE: Record<SkillStatusTag, SkillTagTone> = {
  gone: "warn",
  update: "accent",
  unchecked: "muted",
  edited: "warn",
  folderMissing: "warn",
};

export interface SkillChipRenderer {
  chips: (key: string, name: string, resource: ProfileSkillResource) => ReactNode;
  notice: (key: string) => string | null;
}

interface SkillLibrarySectionProps extends SkillChipRenderer {
  skills: readonly LibrarySkill[];
  checks: Readonly<Record<string, SkillCheck>>;
  checking: boolean;
  selectedKey: string | null;
  onSelect: (skill: LibrarySkill) => void;
  actions: ReturnType<typeof useSkillLibraryActions>;
}

export const librarySkillKey = (skill: LibrarySkill) => `user:${skill.id}`;

export default function SkillLibrarySection({
  skills,
  checks,
  checking,
  selectedKey,
  onSelect,
  actions,
  chips,
  notice,
}: SkillLibrarySectionProps) {
  const { t } = useTranslation("settings");
  const [query, setQuery] = useState("");
  const visible = useMemo(() => filterLibrarySkills(skills, query), [skills, query]);
  const groups = useMemo(() => groupLibrarySkills(visible), [visible]);
  const tracked = skills.some(isTracked);
  const stale = skills.filter((skill) => checks[skill.id]?.status === "update" && !isGone(skill, checks[skill.id]));

  const tagsFor = (skill: LibrarySkill): SkillRowTag[] =>
    skillStatusTags(skill, checks[skill.id]).map((tag) => ({
      key: tag,
      label: t(`skillLibrary.tag.${tag}`),
      tone: TAG_TONE[tag],
      title: tag === "unchecked" ? checks[skill.id]?.error : t(`skillLibrary.tagHint.${tag}`),
    }));

  const rowActions = (skill: LibrarySkill) => {
    const busy = actions.busyIds.has(skill.id);
    return (
      <>
        {isTracked(skill) && !isGone(skill, checks[skill.id]) && (
          <IconTooltipButton label={t("skillLibrary.updateOne", { name: skill.name })} className="h-7 w-7" disabled={busy} onClick={() => actions.updateOne(skill)} data-testid="skill-row-update">
            {busy ? <Loader2 size={13} className="animate-spin" /> : <ArrowUpCircle size={13} />}
          </IconTooltipButton>
        )}
        <IconTooltipButton label={t("skillLibrary.removeOne", { name: skill.name })} className="h-7 w-7 text-destructive" disabled={busy} onClick={() => void actions.removeOne(skill)} data-testid="skill-row-remove">
          <Trash2 size={13} />
        </IconTooltipButton>
      </>
    );
  };

  const groupTitle = (group: LibrarySkillGroup) => (group.kind === "local" ? t("skillLibrary.groupLocal") : group.label);

  return (
    <section className="mb-6" aria-label={t("skillLibrary.inLibrary")} data-testid="skill-library-section">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-xs font-medium" style={{ color: "var(--app-text-secondary)" }}>{t("skillLibrary.inLibrary")}</h2>
        {tracked && (
          <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={checking} onClick={() => void actions.checkAll()} data-testid="skill-check-updates">
            {checking && <Loader2 size={12} className="mr-1 animate-spin" />}
            {checking ? t("skillLibrary.checking") : t("skillLibrary.checkUpdates")}
          </Button>
        )}
        {stale.length > 0 && (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void actions.updateMany(skills, checks)} data-testid="skill-update-all">
            {t("skillLibrary.updateCount", { count: stale.length })}
          </Button>
        )}
      </div>
      {skills.length > SEARCH_THRESHOLD && (
        <div className="relative mb-2">
          <Search size={13} aria-hidden="true" className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2" style={{ color: "var(--app-text-tertiary)" }} />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("skillLibrary.filter", { count: skills.length })}
            aria-label={t("skillLibrary.filter", { count: skills.length })}
            className="h-8 pl-7 text-xs"
          />
        </div>
      )}
      {skills.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-6 text-center" style={{ borderColor: "var(--app-border)" }} data-testid="skill-library-empty">
          <p className="text-[length:var(--text-row)] font-medium" style={{ color: "var(--app-text-primary)" }}>{t("skillLibrary.emptyTitle")}</p>
          <p className="mt-1 text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("skillLibrary.emptyHint")}</p>
        </div>
      ) : groups.length === 0 ? (
        <p className="py-4 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("skillLibrary.noMatch", { query })}</p>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => {
            const goneSkills = group.skills.filter((skill) => isGone(skill, checks[skill.id]));
            return (
              <div key={group.key} className="rounded-lg border" style={{ borderColor: "var(--app-border)" }} data-testid="skill-library-group" data-group={group.key}>
                <div className="flex items-center gap-2 border-b px-3 py-1.5" style={{ borderColor: "var(--app-border)" }}>
                  <span className="truncate text-xs font-medium" style={{ color: "var(--app-text-primary)" }}>{groupTitle(group)}</span>
                  <span className="text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>{t("skillLibrary.groupCount", { count: group.skills.length })}</span>
                  {group.url && (
                    <IconTooltipButton label={t("skillLibrary.openRepo", { repo: group.label })} className="h-6 w-6" onClick={() => void openExternalUrl(group.url!)}>
                      <ExternalLink size={12} />
                    </IconTooltipButton>
                  )}
                  <span className="flex-1" />
                  {goneSkills.length > 0 && (
                    <Button size="sm" variant="ghost" className="h-6 text-xs text-destructive" onClick={() => actions.cleanUp(goneSkills)} data-testid="skill-clean-up">
                      {t("skillLibrary.cleanUp", { count: goneSkills.length })}
                    </Button>
                  )}
                </div>
                <div className="divide-y" style={{ borderColor: "var(--app-border)" }}>
                  {group.skills.map((skill) => {
                    const key = librarySkillKey(skill);
                    return (
                      <SkillRow
                        key={skill.id}
                        rowKey={skill.id}
                        name={skill.name}
                        tags={tagsFor(skill)}
                        description={skill.description}
                        source={group.kind === "local" ? skillSourceText(skill) : skill.provenance.path || null}
                        current={selectedKey === key}
                        onSelect={() => onSelect(skill)}
                        actions={rowActions(skill)}
                        notice={notice(key)}
                        trailing={chips(key, skill.name, { kind: "user", id: skill.id })}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

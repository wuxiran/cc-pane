import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CheckboxRow } from "@/components/ui/CheckboxRow";
import { CollapsibleCheckGroup } from "@/components/ui/CollapsibleCheckGroup";
import { SegmentedTabs } from "@/components/ui/segmented";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { DiscoveredExternalSkill, InstalledUserSkill, LaunchProfileDraft, SkillMarketEntry } from "@/types";
import type { KnownCliTool } from "@/types/terminal";
import type { Workspace } from "@/types/workspace";
import { GroupSearchInput, Section } from "./launchProfileParts";
import LaunchProfileSkillEditor, { type ProfileSkillForm } from "./LaunchProfileSkillEditor";
import {
  BUILTIN_SKILLS,
  EXTERNAL_SKILL_GROUPS,
  externalSkillSourceKind,
  installableMarketEntry,
  isBuiltinSkillSelected,
  isExternalSkillSelected,
  isExternalSourceIncluded,
  isUserSkillSelected,
  selectedBuiltinSkillCount,
  selectedExternalSkillCount,
  selectedUserSkillCount,
  type ExternalSkillSourceKind,
} from "./launchProfileHelpers";

interface LaunchProfileSkillCardProps {
  draft: LaunchProfileDraft;
  setDraft: Dispatch<SetStateAction<LaunchProfileDraft>>;
  activeTool: KnownCliTool;
  externalSkills: DiscoveredExternalSkill[];
  userSkills: InstalledUserSkill[];
  marketEntries: SkillMarketEntry[];
  skillMarketLoading: boolean;
  installingSkillId: string | null;
  refreshSkillMarket: () => void;
  setSkillMode: (mode: LaunchProfileDraft["skillPolicy"]["mode"]) => void;
  selectAllBuiltinSkills: () => void;
  clearBuiltinSkills: () => void;
  toggleSkill: (name: string) => void;
  toggleExternalSource: (kind: ExternalSkillSourceKind, included: boolean) => void;
  toggleExternalSkill: (skill: DiscoveredExternalSkill) => void;
  toggleUserSkill: (id: string) => void;
  installAndEnableSkill: (entry: SkillMarketEntry) => void;
  workspaceContext: Workspace | null;
  openProjectSkillManager: (projectPath: string, title: string) => void;
  profileSkillEditorOpen: boolean;
  editingProfileSkillId: string | null;
  profileSkillForm: ProfileSkillForm;
  setProfileSkillForm: (form: ProfileSkillForm) => void;
  beginNewProfileSkill: () => void;
  beginEditProfileSkill: (id: string) => void;
  cancelProfileSkillEdit: () => void;
  saveProfileSkill: () => void;
  toggleProfileSkill: (id: string) => void;
  deleteProfileSkill: (id: string) => void;
}

export default function LaunchProfileSkillCard({
  draft,
  setDraft,
  activeTool,
  externalSkills,
  userSkills,
  marketEntries,
  skillMarketLoading,
  installingSkillId,
  refreshSkillMarket,
  setSkillMode,
  selectAllBuiltinSkills,
  clearBuiltinSkills,
  toggleSkill,
  toggleExternalSource,
  toggleExternalSkill,
  toggleUserSkill,
  installAndEnableSkill,
  workspaceContext,
  openProjectSkillManager,
  profileSkillEditorOpen,
  editingProfileSkillId,
  profileSkillForm,
  setProfileSkillForm,
  beginNewProfileSkill,
  beginEditProfileSkill,
  cancelProfileSkillEdit,
  saveProfileSkill,
  toggleProfileSkill,
  deleteProfileSkill,
}: LaunchProfileSkillCardProps) {
  const { t } = useTranslation(["providers", "common"]);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!normalizedQuery) return () => true;
    return (name: string, description?: string | null) =>
      name.toLowerCase().includes(normalizedQuery)
      || (description ?? "").toLowerCase().includes(normalizedQuery);
  }, [normalizedQuery]);
  const searching = normalizedQuery.length > 0;
  const builtinSkillSelectedCount = selectedBuiltinSkillCount(draft.skillPolicy);
  const installedUserSkillIds = new Set(userSkills.map((skill) => skill.id));
  const marketEntryIds = new Set(marketEntries.map((entry) => entry.id));
  const standaloneUserSkills = userSkills.filter((skill) => !marketEntryIds.has(skill.id));
  const userSkillSelectedCount = selectedUserSkillCount(draft.skillPolicy, userSkills);
  const visibleExternalSkillGroups = EXTERNAL_SKILL_GROUPS.filter((group) =>
    group.applicableTools.includes(activeTool),
  );
  const visibleExternalSkillKinds = new Set(visibleExternalSkillGroups.map((group) => group.kind));
  const visibleExternalSkills = externalSkills.filter((skill) =>
    visibleExternalSkillKinds.has(externalSkillSourceKind(skill)),
  );
  const externalSkillSelectedCount = selectedExternalSkillCount(draft.skillPolicy, visibleExternalSkills);
  const externalSkillGroups = visibleExternalSkillGroups.map((group) => ({
    ...group,
    skills: externalSkills
      .filter((skill) => externalSkillSourceKind(skill) === group.kind)
      .filter((skill) => matches(skill.name, skill.description)),
  }));
  // 搜索只裁剪可见行，分组计数仍按全量：否则「12 项 · 启用 3」会随查询词跳变
  const visibleBuiltinSkills = BUILTIN_SKILLS.filter((name) => matches(name));
  const visibleMarketEntries = marketEntries.filter((entry) => matches(entry.name, entry.description));
  const visibleStandaloneUserSkills = standaloneUserSkills.filter((skill) => matches(skill.name, skill.description));
  const marketGroupEmpty = visibleMarketEntries.length === 0 && visibleStandaloneUserSkills.length === 0;
  const externalGroupEmpty = externalSkillGroups.every((group) => group.skills.length === 0);

  return (
            <Section
              title="Skill"
              description={t("sectionSkillDesc")}
              icon={<Sparkles size={16} />}
              headerActions={
                <GroupSearchInput value={query} onChange={setQuery} placeholder={t("searchSkillPlaceholder")} />
              }
            >
              <SegmentedTabs
                size="sm"
                value={draft.skillPolicy.mode}
                onValueChange={(mode) => setSkillMode(mode)}
                items={(["core", "custom", "disabled"] as const).map((mode) => ({
                  value: mode,
                  label: t(`skillMode.${mode}`),
                }))}
              />

              <div className="mt-2.5 text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                {draft.skillPolicy.mode === "disabled"
                  ? t("skillDisabledHint")
                  : draft.skillPolicy.mode === "custom"
                    ? t("skillCustomHint")
                    : t("skillDefaultHint")}
              </div>

              <div className="mt-3">
                <CollapsibleCheckGroup
                  title={t("builtinSkill")}
                  total={BUILTIN_SKILLS.length}
                  enabledCount={builtinSkillSelectedCount}
                  formatCount={(total, enabled) => t("groupCount", { total, enabled })}
                  forceOpen={searching}
                  actions={
                    <>
                      <Button size="xs" variant="ghost" onClick={selectAllBuiltinSkills}>
                        {t("common:selectAll")}
                      </Button>
                      <Button size="xs" variant="ghost" onClick={clearBuiltinSkills}>
                        {t("clear")}
                      </Button>
                    </>
                  }
                >
                  {visibleBuiltinSkills.length === 0 ? (
                    <div className="px-1 py-3 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                      {t("searchNoMatch")}
                    </div>
                  ) : visibleBuiltinSkills.map((name) => {
                    const checked = isBuiltinSkillSelected(draft.skillPolicy, name);
                    return (
                      <CheckboxRow
                        key={name}
                        checked={checked}
                        onCheckedChange={() => toggleSkill(name)}
                        label={name}
                        trailing={<Badge variant="secondary" className="text-[10px]">{t("builtinBadge")}</Badge>}
                      />
                    );
                  })}
                </CollapsibleCheckGroup>
              </div>

              {visibleExternalSkillGroups.length > 0 && (
                <div className="mt-2">
                  <CollapsibleCheckGroup
                    title="External Skills"
                    total={visibleExternalSkills.length}
                    enabledCount={externalSkillSelectedCount}
                    enabledNames={visibleExternalSkills.filter((skill) => isExternalSkillSelected(draft.skillPolicy, skill)).map((skill) => skill.name)}
                    formatCount={(total, enabled) => t("groupCount", { total, enabled })}
                    formatMore={(hidden) => t("expandMore", { count: hidden })}
                    forceOpen={searching}
                    actions={
                      <Button size="xs" variant="ghost" disabled={skillMarketLoading} onClick={refreshSkillMarket}>
                        {skillMarketLoading ? t("refreshing") : t("refresh")}
                      </Button>
                    }
                  >
                    <div className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                      {t("externalSkillHint")}
                    </div>
                    <div className="flex flex-wrap gap-2 py-1">
                      {visibleExternalSkillGroups.map((group) => {
                        const included = isExternalSourceIncluded(draft.skillPolicy, group.kind);
                        return (
                          <label
                            key={group.kind}
                            className="flex cursor-pointer items-center gap-1.5 rounded-md border border-[var(--app-border)] px-2 py-1 text-xs hover:bg-[var(--app-hover)]"
                          >
                            <Checkbox
                              checked={included}
                              onCheckedChange={(next) => toggleExternalSource(group.kind, next === true)}
                            />
                            {group.label}
                          </label>
                        );
                      })}
                    </div>

                    {skillMarketLoading && visibleExternalSkills.length === 0 ? (
                      <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                        {t("loadingExternalSkills")}
                      </div>
                    ) : searching && externalGroupEmpty ? (
                      <div className="px-1 py-3 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                        {t("searchNoMatch")}
                      </div>
                    ) : visibleExternalSkills.length === 0 ? (
                      <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                        {t("noExternalSkills", { sources: visibleExternalSkillGroups.map((group) => group.label).join(", ") })}
                      </div>
                    ) : externalSkillGroups.filter((group) => !searching || group.skills.length > 0).map((group) => {
                      const included = isExternalSourceIncluded(draft.skillPolicy, group.kind);
                      const selectedCount = selectedExternalSkillCount(draft.skillPolicy, group.skills);
                      return (
                        <div key={group.kind} className="pt-1">
                          <div className="pb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em]" style={{ color: "var(--app-text-tertiary)" }}>
                            {group.label} ({selectedCount}/{group.skills.length})
                          </div>
                          <div className="space-y-1.5">
                            {group.skills.length === 0 ? (
                              <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                                {t("noSkillInSource")}
                              </div>
                            ) : group.skills.map((skill) => {
                              const checked = isExternalSkillSelected(draft.skillPolicy, skill);
                              return (
                                <CheckboxRow
                                  key={skill.id}
                                  checked={checked}
                                  disabled={!included}
                                  onCheckedChange={() => toggleExternalSkill(skill)}
                                  label={skill.name}
                                  description={skill.description || undefined}
                                  trailing={<Badge variant="secondary" className="text-[10px]">{group.label}</Badge>}
                                />
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </CollapsibleCheckGroup>
                </div>
              )}

              <div className="mt-2">
                <CollapsibleCheckGroup
                  title={t("skillMarket")}
                  total={Math.max(userSkills.length, marketEntries.length + standaloneUserSkills.length)}
                  enabledCount={userSkillSelectedCount}
                  enabledNames={userSkills.filter((skill) => isUserSkillSelected(draft.skillPolicy, skill.id)).map((skill) => skill.name)}
                  formatCount={(total, enabled) => t("groupCount", { total, enabled })}
                  formatMore={(hidden) => t("expandMore", { count: hidden })}
                  forceOpen={searching}
                  actions={
                    <Button size="xs" variant="ghost" disabled={skillMarketLoading} onClick={refreshSkillMarket}>
                      {skillMarketLoading ? t("refreshing") : t("refresh")}
                    </Button>
                  }
                >
                  <div className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                    {t("skillMarketHint")}
                  </div>
                  {skillMarketLoading && marketEntries.length === 0 && standaloneUserSkills.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                      {t("loadingMarket")}
                    </div>
                  ) : marketEntries.length === 0 && standaloneUserSkills.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                      {t("noMarketEntries")}
                    </div>
                  ) : marketGroupEmpty ? (
                    <div className="px-1 py-3 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                      {t("searchNoMatch")}
                    </div>
                  ) : (
                    <>
                      {visibleMarketEntries.map((entry) => {
                        const installed = installedUserSkillIds.has(entry.id);
                        const checked = installed && isUserSkillSelected(draft.skillPolicy, entry.id);
                        const installable = installableMarketEntry(entry);
                        return (
                          <div
                            key={entry.id}
                            className={cn(
                              "relative flex items-start gap-2.5 rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm transition-colors hover:bg-[var(--app-hover)]",
                              checked &&
                                "before:absolute before:bottom-1.5 before:left-0 before:top-1.5 before:w-0.5 before:rounded-full before:bg-[var(--app-accent)] before:content-['']",
                            )}
                          >
                            <Checkbox
                              className="mt-0.5"
                              checked={checked}
                              disabled={!installed}
                              onCheckedChange={() => toggleUserSkill(entry.id)}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="truncate text-[13px]">{entry.name}</span>
                                {entry.recommended && <Badge variant="secondary" className="text-[10px]">{t("recommendedBadge")}</Badge>}
                                {entry.category && <Badge variant="outline" className="text-[10px]">{entry.category}</Badge>}
                              </div>
                              {entry.description && (
                                <div className="mt-0.5 line-clamp-2 text-[11.5px]" style={{ color: "var(--app-text-tertiary)" }}>
                                  {entry.description}
                                </div>
                              )}
                              <div className="mt-0.5 flex flex-wrap gap-2 text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                                <span>v{entry.version}</span>
                                {entry.license ? <span>{entry.license}</span> : <span>{t("missingLicense")}</span>}
                              </div>
                            </div>
                            {installed ? (
                              <Badge variant="secondary" className="shrink-0 text-[10px]">{t("installed")}</Badge>
                            ) : (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="shrink-0">
                                    <Button
                                      size="xs"
                                      variant="outline"
                                      disabled={!installable || installingSkillId === entry.id}
                                      onClick={() => installAndEnableSkill(entry)}
                                    >
                                      {installingSkillId === entry.id ? t("installing") : t("installAndEnable")}
                                    </Button>
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="left" sideOffset={6}>
                                  {installable ? t("installTitle") : t("installBlockedTitle")}
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </div>
                        );
                      })}
                      {visibleStandaloneUserSkills.map((skill) => {
                        const checked = isUserSkillSelected(draft.skillPolicy, skill.id);
                        return (
                          <CheckboxRow
                            key={skill.id}
                            checked={checked}
                            onCheckedChange={() => toggleUserSkill(skill.id)}
                            label={skill.name}
                            description={skill.description || undefined}
                            trailing={<Badge variant="secondary" className="text-[10px]">{t("userLibBadge")}</Badge>}
                          />
                        );
                      })}
                    </>
                  )}
                </CollapsibleCheckGroup>
              </div>

              <LaunchProfileSkillEditor
                draft={draft}
                profileSkillEditorOpen={profileSkillEditorOpen}
                editingProfileSkillId={editingProfileSkillId}
                profileSkillForm={profileSkillForm}
                setProfileSkillForm={setProfileSkillForm}
                onBeginNew={beginNewProfileSkill}
                onBeginEdit={beginEditProfileSkill}
                onCancel={cancelProfileSkillEdit}
                onSave={saveProfileSkill}
                onToggle={toggleProfileSkill}
                onDelete={deleteProfileSkill}
              />

              <div className="mt-3 border-t border-[var(--app-border)]/60 pt-2">
                <div className="flex flex-wrap items-center justify-between gap-2 py-1">
                  <div>
                    <div className="text-[12.5px] font-semibold" style={{ color: "var(--app-text-primary)" }}>
                      {t("workspaceProjectSkill")}
                    </div>
                    <div className="mt-0.5 text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                      {workspaceContext
                        ? t("projectSkillWorkspaceHint")
                        : t("projectSkillSelectHint")}
                    </div>
                  </div>
                  <label className="flex cursor-pointer items-center gap-2 text-xs" style={{ color: "var(--app-text-secondary)" }}>
                    <Checkbox
                      checked={draft.skillPolicy.includeProjectSkills}
                      onCheckedChange={(next) => setDraft((current) => ({ ...current, skillPolicy: { ...current.skillPolicy, includeProjectSkills: next === true } }))}
                    />
                    {t("enableProjectSkill")}
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 text-xs" style={{ color: "var(--app-text-secondary)" }}>
                    <Checkbox
                      checked={draft.skillPolicy.includeWorkspaceSkills !== false}
                      onCheckedChange={(next) => setDraft((current) => ({ ...current, skillPolicy: { ...current.skillPolicy, includeWorkspaceSkills: next === true } }))}
                    />
                    {t("enableWorkspaceSkill")}
                  </label>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!workspaceContext || workspaceContext.projects.length !== 1}
                    onClick={() => {
                      const project = workspaceContext?.projects[0];
                      if (project) openProjectSkillManager(project.path, project.alias || project.path);
                    }}
                  >
                    <Plus size={12} /> {t("addProjectSkill")}
                  </Button>
                </div>
                {workspaceContext ? (
                  workspaceContext.projects.length > 0 ? (
                    <div className="mt-2 space-y-1.5">
                      {workspaceContext.projects.map((project) => (
                        <div
                          key={project.id}
                          className="flex items-center gap-2 rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm"
                        >
                          <span className="min-w-0 flex-1 truncate text-[13px]">{project.alias || project.path}</span>
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => openProjectSkillManager(project.path, project.alias || project.path)}
                          >
                            <Plus size={12} /> {t("addOrEdit")}
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-2 rounded-md border border-dashed border-border px-3 py-5 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                      {t("noProjects")}
                    </div>
                  )
                ) : null}
              </div>
            </Section>
  );
}

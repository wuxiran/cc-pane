import type { Dispatch, SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { Boxes, Sparkles } from "lucide-react";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { SegmentedTabs } from "@/components/ui/segmented";
import { openResourceLibrary } from "@/stores/useResourceLibraryStore";
import { useSkillLibraryStore } from "@/stores/useSkillLibraryStore";
import type { LaunchProfileDraft, ResolvedSkill } from "@/types";
import type { KnownCliTool } from "@/types/terminal";
import { EffectiveList, InlineCheck, Section } from "./launchProfileParts";
import LaunchProfileSkillEditor, { type ProfileSkillForm } from "./LaunchProfileSkillEditor";
import {
  BUILTIN_SKILLS,
  SECTION_IDS,
  externalSkillGroupsFor,
  isBuiltinSkillSelected,
  isExternalSourceIncluded,
  isUserSkillSelected,
  type ExternalSkillSourceKind,
} from "./launchProfileHelpers";
import { PendingAdditions } from "./LaunchProfileAddPicker";
import { pendingAdditions } from "./launchProfileAddModel";
import LaunchProfileSkillAdd from "./LaunchProfileSkillAdd";

interface LaunchProfileSkillCardProps {
  draft: LaunchProfileDraft;
  setDraft: Dispatch<SetStateAction<LaunchProfileDraft>>;
  activeTool: KnownCliTool;
  setSkillMode: (mode: LaunchProfileDraft["skillPolicy"]["mode"]) => void;
  toggleExternalSource: (kind: ExternalSkillSourceKind, included: boolean) => void;
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
  /** 后端启动预览里实际启用的 Skill；null = 预览未就绪 */
  effective?: readonly ResolvedSkill[] | null;
  effectiveStale?: boolean;
}

/**
 * 启动档只管技能的总策略和组开关；资源库里的每个技能、内置技能开给哪些启动档统一在资源库改。
 * 启动档自带的内联技能属于启动档本身，仍在这里编辑。
 */
export default function LaunchProfileSkillCard({
  draft,
  setDraft,
  activeTool,
  setSkillMode,
  toggleExternalSource,
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
  effective,
  effectiveStale,
}: LaunchProfileSkillCardProps) {
  const { t } = useTranslation(["providers", "common", "settings"]);
  const disabled = draft.skillPolicy.mode === "disabled";
  const externalGroups = externalSkillGroupsFor(activeTool);
  const setPolicyFlag = (key: "includeProjectSkills" | "includeWorkspaceSkills", value: boolean) =>
    setDraft((current) => ({ ...current, skillPolicy: { ...current.skillPolicy, [key]: value } }));
  // 刚从「新增」勾选、还没保存的技能：预览按已保存配置算，先在卡里标出来
  const librarySkills = useSkillLibraryStore((state) => state.skills);
  const pending = effectiveStale
    ? pendingAdditions(
      [
        ...librarySkills.filter((skill) => isUserSkillSelected(draft.skillPolicy, skill.id)).map((skill) => skill.name),
        ...BUILTIN_SKILLS.filter((name) => isBuiltinSkillSelected(draft.skillPolicy, name)),
      ],
      effective,
    )
    : [];

  return (
    <Section
      id={SECTION_IDS.skill}
      title={t("launchSkillTitle")}
      hint={disabled ? t("skillDisabledHint") : draft.skillPolicy.mode === "custom" ? t("skillCustomHint") : t("skillDefaultHint")}
      icon={<Sparkles size={14} />}
      headerControl={
        <SegmentedTabs
          size="sm"
          value={draft.skillPolicy.mode}
          onValueChange={(mode) => setSkillMode(mode)}
          items={(["core", "custom", "disabled"] as const).map((mode) => ({
            value: mode,
            label: t(`skillMode.${mode}`),
          }))}
        />
      }
      headerActions={
        <>
        <LaunchProfileSkillAdd draft={draft} setDraft={setDraft} onHandwrite={beginNewProfileSkill} />
        <IconTooltipButton
          label={t("settings:resourceLibrary.openSkillsInLibrary")}
          onClick={() => openResourceLibrary("skills")}
          data-testid="open-skills-library"
          className="h-7 w-7"
        >
          <Boxes size={14} />
        </IconTooltipButton>
        </>
      }
    >
      {!disabled && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <InlineCheck
            checked={draft.skillPolicy.includeWorkspaceSkills !== false}
            onCheckedChange={(next) => setPolicyFlag("includeWorkspaceSkills", next)}
            label={t("enableWorkspaceSkill")}
          />
          <InlineCheck
            checked={draft.skillPolicy.includeProjectSkills}
            onCheckedChange={(next) => setPolicyFlag("includeProjectSkills", next)}
            label={t("enableProjectSkill")}
            hint={t("projectSkillWorkspaceHint")}
          />
          {externalGroups.map((group) => (
            <InlineCheck
              key={group.kind}
              checked={isExternalSourceIncluded(draft.skillPolicy, group.kind)}
              onCheckedChange={(next) => toggleExternalSource(group.kind, next)}
              label={`${t("launchExternalSkills")} · ${group.label}`}
            />
          ))}
        </div>
      )}

      {!disabled && <EffectiveList items={effective} stale={effectiveStale} testId="skill-effective" />}
      {!disabled && <PendingAdditions names={pending} testId="skill-pending" />}

      <LaunchProfileSkillEditor
        draft={draft}
        profileSkillEditorOpen={profileSkillEditorOpen}
        editingProfileSkillId={editingProfileSkillId}
        profileSkillForm={profileSkillForm}
        setProfileSkillForm={setProfileSkillForm}
        onBeginEdit={beginEditProfileSkill}
        onCancel={cancelProfileSkillEdit}
        onSave={saveProfileSkill}
        onToggle={toggleProfileSkill}
        onDelete={deleteProfileSkill}
      />
    </Section>
  );
}

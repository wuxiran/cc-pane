import type { Dispatch, SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { Boxes, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CheckboxRow } from "@/components/ui/CheckboxRow";
import { SegmentedTabs } from "@/components/ui/segmented";
import { openResourceLibrary } from "@/stores/useResourceLibraryStore";
import type { LaunchProfileDraft } from "@/types";
import type { KnownCliTool } from "@/types/terminal";
import { Section } from "./launchProfileParts";
import LaunchProfileSkillEditor, { type ProfileSkillForm } from "./LaunchProfileSkillEditor";
import { EXTERNAL_SKILL_GROUPS, isExternalSourceIncluded, type ExternalSkillSourceKind } from "./launchProfileHelpers";

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
}: LaunchProfileSkillCardProps) {
  const { t } = useTranslation(["providers", "common", "settings"]);
  const disabled = draft.skillPolicy.mode === "disabled";
  const externalGroups = EXTERNAL_SKILL_GROUPS.filter((group) => group.applicableTools.includes(activeTool));
  const setPolicyFlag = (key: "includeProjectSkills" | "includeWorkspaceSkills", value: boolean) =>
    setDraft((current) => ({ ...current, skillPolicy: { ...current.skillPolicy, [key]: value } }));

  return (
    <Section
      title={t("launchSkillTitle")}
      description={t("sectionSkillDesc")}
      icon={<Sparkles size={16} />}
      headerActions={
        <Button size="sm" variant="outline" onClick={() => openResourceLibrary("skills")} data-testid="open-skills-library">
          <Boxes size={14} />
          {t("settings:resourceLibrary.openSkillsInLibrary")}
        </Button>
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
        {disabled
          ? t("skillDisabledHint")
          : draft.skillPolicy.mode === "custom"
            ? t("skillCustomHint")
            : t("skillDefaultHint")}
      </div>

      {!disabled && (
        <div className="mt-3 space-y-1.5">
          <CheckboxRow
            checked={draft.skillPolicy.includeWorkspaceSkills !== false}
            onCheckedChange={(next) => setPolicyFlag("includeWorkspaceSkills", next)}
            label={t("enableWorkspaceSkill")}
          />
          <CheckboxRow
            checked={draft.skillPolicy.includeProjectSkills}
            onCheckedChange={(next) => setPolicyFlag("includeProjectSkills", next)}
            label={t("enableProjectSkill")}
            description={t("projectSkillWorkspaceHint")}
          />
          {externalGroups.length > 0 && (
            <div className="pt-1">
              <div className="pb-1 text-[length:var(--text-caption)] font-semibold" style={{ color: "var(--app-text-tertiary)" }}>
                {t("launchExternalSkills")}
              </div>
              {externalGroups.map((group) => (
                <CheckboxRow
                  key={group.kind}
                  checked={isExternalSourceIncluded(draft.skillPolicy, group.kind)}
                  onCheckedChange={(next) => toggleExternalSource(group.kind, next)}
                  label={group.label}
                />
              ))}
            </div>
          )}
        </div>
      )}

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
    </Section>
  );
}

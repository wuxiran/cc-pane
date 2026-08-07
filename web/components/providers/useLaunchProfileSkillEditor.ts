import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { LaunchProfileDraft } from "@/types";
import {
  nextDeleteProfileSkill,
  nextUpsertProfileSkill,
} from "./launchProfileSkillPolicy";

const EMPTY_FORM = { name: "", description: "", content: "" };

export function useLaunchProfileSkillEditor(
  draft: LaunchProfileDraft,
  setDraft: Dispatch<SetStateAction<LaunchProfileDraft>>,
) {
  const { t } = useTranslation("providers");
  const [profileSkillEditorOpen, setProfileSkillEditorOpen] = useState(false);
  const [editingProfileSkillId, setEditingProfileSkillId] = useState<string | null>(null);
  const [profileSkillForm, setProfileSkillForm] = useState(EMPTY_FORM);

  const beginNewProfileSkill = useCallback(() => {
    setProfileSkillEditorOpen(true);
    setEditingProfileSkillId(null);
    setProfileSkillForm(EMPTY_FORM);
  }, []);

  const beginEditProfileSkill = useCallback((id: string) => {
    const skill = draft.skillPolicy.profileSkills.find((item) => item.id === id);
    if (!skill) return;
    setProfileSkillEditorOpen(true);
    setEditingProfileSkillId(id);
    setProfileSkillForm({
      name: skill.name,
      description: skill.description ?? "",
      content: skill.content,
    });
  }, [draft.skillPolicy.profileSkills]);

  const cancelProfileSkillEdit = useCallback(() => {
    setProfileSkillEditorOpen(false);
    setEditingProfileSkillId(null);
    setProfileSkillForm(EMPTY_FORM);
  }, []);

  const saveProfileSkill = useCallback(() => {
    const name = profileSkillForm.name.trim();
    const content = profileSkillForm.content.trim();
    if (!name || !content) {
      toast.error(t("toast.profileSkillRequired"));
      return;
    }

    const id = editingProfileSkillId ?? crypto.randomUUID();
    setDraft((current) => nextUpsertProfileSkill(current, {
      id,
      name,
      description: profileSkillForm.description.trim() || null,
      content,
    }));
    cancelProfileSkillEdit();
  }, [cancelProfileSkillEdit, editingProfileSkillId, profileSkillForm, setDraft, t]);

  const deleteProfileSkill = useCallback((id: string) => {
    setDraft((current) => nextDeleteProfileSkill(current, id));
    if (editingProfileSkillId === id) cancelProfileSkillEdit();
  }, [cancelProfileSkillEdit, editingProfileSkillId, setDraft]);

  return {
    profileSkillEditorOpen,
    editingProfileSkillId,
    profileSkillForm,
    setProfileSkillForm,
    beginNewProfileSkill,
    beginEditProfileSkill,
    cancelProfileSkillEdit,
    saveProfileSkill,
    deleteProfileSkill,
  };
}

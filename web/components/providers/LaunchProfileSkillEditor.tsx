import { Pencil, Plus, Save, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { LaunchProfileDraft } from "@/types";
import { Field } from "./launchProfileParts";
import { inputClass, isProfileSkillSelected, selectedProfileSkillCount } from "./launchProfileHelpers";

export interface ProfileSkillForm {
  name: string;
  description: string;
  content: string;
}

interface LaunchProfileSkillEditorProps {
  draft: LaunchProfileDraft;
  profileSkillEditorOpen: boolean;
  editingProfileSkillId: string | null;
  profileSkillForm: ProfileSkillForm;
  setProfileSkillForm: (form: ProfileSkillForm) => void;
  onBeginNew: () => void;
  onBeginEdit: (id: string) => void;
  onCancel: () => void;
  onSave: () => void;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
}

/** Skill 卡内的「配置内联 Skill」子块（新建/编辑表单 + 列表） */
export default function LaunchProfileSkillEditor({
  draft,
  profileSkillEditorOpen,
  editingProfileSkillId,
  profileSkillForm,
  setProfileSkillForm,
  onBeginNew,
  onBeginEdit,
  onCancel,
  onSave,
  onToggle,
  onDelete,
}: LaunchProfileSkillEditorProps) {
  const { t } = useTranslation(["providers", "common"]);
  const profileSkillSelectedCount = selectedProfileSkillCount(draft.skillPolicy);

  return (
              <div className="mt-3 border-t border-[var(--app-border)]/60 pt-2">
                <div className="flex flex-wrap items-center justify-between gap-2 py-1">
                  <div>
                    <div className="flex items-center gap-2">
                      <div className="text-[12.5px] font-semibold" style={{ color: "var(--app-text-primary)" }}>
                        {t("profileSkill")}
                      </div>
                      <span className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                        {t("groupCount", { total: draft.skillPolicy.profileSkills.length, enabled: profileSkillSelectedCount })}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                      {t("profileSkillHint")}
                    </div>
                  </div>
                  <Button size="xs" variant="outline" onClick={onBeginNew}>
                    <Plus size={12} /> {t("add")}
                  </Button>
                </div>

                {profileSkillEditorOpen && (
                  <div className="mt-2 rounded-md border border-[var(--app-border)] p-3">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <div className="text-xs font-semibold" style={{ color: "var(--app-text-primary)" }}>
                        {editingProfileSkillId ? t("editProfileSkill") : t("newProfileSkill")}
                      </div>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onCancel}>
                        <X size={13} />
                      </Button>
                    </div>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <Field label={t("fieldName")}>
                        <input
                          className={inputClass}
                          value={profileSkillForm.name}
                          onChange={(event) => setProfileSkillForm({ ...profileSkillForm, name: event.target.value })}
                          placeholder="review-guard"
                        />
                      </Field>
                      <Field label={t("fieldDescription")}>
                        <input
                          className={inputClass}
                          value={profileSkillForm.description}
                          onChange={(event) => setProfileSkillForm({ ...profileSkillForm, description: event.target.value })}
                          placeholder={t("profileSkillDescPlaceholder")}
                        />
                      </Field>
                    </div>
                    <div className="mt-3">
                      <Field label={t("fieldContent")}>
                        <textarea
                          className="min-h-28 w-full rounded-md border bg-background px-3 py-2 text-sm"
                          value={profileSkillForm.content}
                          onChange={(event) => setProfileSkillForm({ ...profileSkillForm, content: event.target.value })}
                          placeholder={t("profileSkillContentPlaceholder")}
                        />
                      </Field>
                    </div>
                    <div className="mt-3 flex justify-end gap-2">
                      <Button size="xs" variant="outline" onClick={onCancel}>
                        {t("common:cancel")}
                      </Button>
                      <Button size="xs" onClick={onSave}>
                        <Save size={12} /> {t("saveSkill")}
                      </Button>
                    </div>
                  </div>
                )}

                <div className="mt-2 space-y-1.5">
                  {draft.skillPolicy.profileSkills.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                      {t("profileSkillEmpty")}
                    </div>
                  ) : draft.skillPolicy.profileSkills.map((skill) => {
                    const checked = isProfileSkillSelected(draft.skillPolicy, skill.id);
                    return (
                      <div
                        key={skill.id}
                        className={cn(
                          "relative flex items-start gap-2.5 rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm transition-colors hover:bg-[var(--app-hover)]",
                          checked &&
                            "before:absolute before:bottom-1.5 before:left-0 before:top-1.5 before:w-0.5 before:rounded-full before:bg-[var(--app-accent)] before:content-['']",
                        )}
                      >
                        <Checkbox
                          className="mt-0.5"
                          checked={checked}
                          onCheckedChange={() => onToggle(skill.id)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px]">{skill.name}</span>
                          {skill.description && (
                            <span className="block truncate text-[11.5px]" style={{ color: "var(--app-text-tertiary)" }}>
                              {skill.description}
                            </span>
                          )}
                        </span>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6 shrink-0"
                          onClick={() => onBeginEdit(skill.id)}
                        >
                          <Pencil size={12} />
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6 shrink-0 text-[var(--app-status-danger)]"
                          onClick={() => onDelete(skill.id)}
                        >
                          <Trash2 size={12} />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </div>
  );
}

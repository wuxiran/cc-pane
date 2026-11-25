// Skill 卡的「新增」：主路径是从资源库已安装 / 内置技能里勾选开给本配置；
// 没有合适的就去技能市场装，实在要自己写才走「手写一个 Skill」。
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { PenLine, Store } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openResourceLibrary } from "@/stores/useResourceLibraryStore";
import { useSkillLibraryStore } from "@/stores/useSkillLibraryStore";
import type { LaunchProfileDraft } from "@/types";
import { handleErrorSilent } from "@/utils/errorHandler";
import AddPicker, { type AddPickerGroup } from "./LaunchProfileAddPicker";
import { BUILTIN_SKILLS, isBuiltinSkillSelected, isUserSkillSelected } from "./launchProfileHelpers";
import { nextSetSkill } from "./launchProfileAddModel";

const USER_PREFIX = "user:";
const BUILTIN_PREFIX = "builtin:";

interface LaunchProfileSkillAddProps {
  draft: LaunchProfileDraft;
  setDraft: Dispatch<SetStateAction<LaunchProfileDraft>>;
  onHandwrite: () => void;
}

export default function LaunchProfileSkillAdd({ draft, setDraft, onHandwrite }: LaunchProfileSkillAddProps) {
  const { t } = useTranslation("providers");
  const skills = useSkillLibraryStore((s) => s.skills);
  const load = useSkillLibraryStore((s) => s.load);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (open) void load().catch((error) => handleErrorSilent(error, "load skill library"));
  }, [open, load]);

  const policy = draft.skillPolicy;
  const groups: AddPickerGroup[] = [
    {
      label: t("profileAdd.skillLibraryGroup"),
      items: skills
        .filter((skill) => !skill.folderMissing)
        .map((skill) => ({
          key: `${USER_PREFIX}${skill.id}`,
          name: skill.name,
          description: skill.description ?? null,
          checked: isUserSkillSelected(policy, skill.id),
        })),
    },
    {
      label: t("profileAdd.skillBuiltinGroup"),
      items: BUILTIN_SKILLS.map((name) => ({
        key: `${BUILTIN_PREFIX}${name}`,
        name,
        checked: isBuiltinSkillSelected(policy, name),
      })),
    },
  ];

  const toggle = (key: string, on: boolean) => {
    const resource = key.startsWith(USER_PREFIX)
      ? { kind: "user" as const, id: key.slice(USER_PREFIX.length) }
      : { kind: "builtin" as const, name: key.slice(BUILTIN_PREFIX.length) };
    setDraft((current) => nextSetSkill(current, resource, on));
  };

  return (
    <AddPicker
      testId="skill-add"
      title={t("profileAdd.skillTitle")}
      open={open}
      onOpenChange={setOpen}
      disabledNote={policy.mode === "disabled" ? t("profileAdd.skillDisabled") : null}
      emptyText={t("profileAdd.skillEmpty")}
      footnote={skills.length === 0 ? t("profileAdd.skillEmpty") : t("profileAdd.skillExternalHint")}
      groups={groups}
      onToggle={toggle}
      footer={(
        <>
          <Button size="xs" variant="ghost" data-testid="skill-add-market" onClick={() => { setOpen(false); openResourceLibrary("skills"); }}>
            <Store size={12} /> {t("profileAdd.skillMarket")}
          </Button>
          <Button size="xs" variant="ghost" data-testid="skill-add-handwrite" onClick={() => { setOpen(false); onHandwrite(); }}>
            <PenLine size={12} /> {t("profileAdd.skillHandwrite")}
          </Button>
        </>
      )}
    />
  );
}

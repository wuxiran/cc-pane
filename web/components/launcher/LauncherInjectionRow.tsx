// 启动注入：本地文件（plugin-dialog + filesystemService.readFile，与编辑器同一 fs_read_file 通道）
// 或项目 Skill（skillService 列表 + 取内容）→ 拼进 appendSystemPrompt（默认）或 initialPrompt。
// >8KB（UTF-8 字节）截断并 toast 告警；截断/拼接规则见 launcherInjection.ts。
import { useEffect, useState } from "react";
import { FileText, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { filesystemService, skillService } from "@/services";
import type { SkillSummary } from "@/types";
import { appendInjection, clampInjection } from "./launcherInjection";
import type { LauncherDraft, LauncherInjectionTarget } from "./launcherModel";

interface LauncherInjectionRowProps {
  draft: LauncherDraft;
  onChange: (patch: Partial<LauncherDraft>) => void;
  /** 当前草稿解析出的项目路径（Skill 列表用）；无则 Skill 选择置灰 */
  projectPath?: string;
}

const TARGETS: LauncherInjectionTarget[] = ["append", "initial"];

export default function LauncherInjectionRow({
  draft,
  onChange,
  projectPath,
}: LauncherInjectionRowProps) {
  const { t } = useTranslation("launcher");
  const [target, setTarget] = useState<LauncherInjectionTarget>("append");
  const [skills, setSkills] = useState<SkillSummary[]>([]);

  useEffect(() => {
    let disposed = false;
    if (!projectPath) {
      setSkills([]);
      return;
    }
    skillService
      .listSkills(projectPath)
      .then((list) => {
        if (!disposed) setSkills(list);
      })
      .catch(() => {
        if (!disposed) setSkills([]);
      });
    return () => {
      disposed = true;
    };
  }, [projectPath]);

  function inject(label: string, content: string) {
    const { text, truncated } = clampInjection(content);
    if (truncated) toast.warning(t("injectionTruncated"));
    if (target === "append") {
      onChange({
        appendSystemPrompt: appendInjection(draft.appendSystemPrompt, text),
        injection: { label, target },
      });
    } else {
      onChange({
        initialPrompt: appendInjection(draft.initialPrompt, text),
        injection: { label, target },
      });
    }
  }

  async function injectLocalFile() {
    try {
      const selected = await openFileDialog({
        multiple: false,
        title: t("pickInjectionFile"),
      });
      if (typeof selected !== "string" || !selected) return;
      const file = await filesystemService.readFile(selected);
      inject(selected.split(/[/\\]/).pop() || selected, file.content);
    } catch {
      toast.error(t("injectionReadFailed"));
    }
  }

  async function injectSkill(name: string) {
    if (!name || !projectPath) return;
    try {
      const skill = await skillService.getSkill(projectPath, name);
      if (!skill) {
        toast.error(t("injectionReadFailed"));
        return;
      }
      inject(skill.name, skill.content);
    } catch {
      toast.error(t("injectionReadFailed"));
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <div
          className="inline-flex items-center gap-0.5 rounded-lg border p-0.5"
          style={{ borderColor: "var(--app-border)" }}
          role="radiogroup"
          aria-label={t("injectionTarget")}
        >
          {TARGETS.map((item) => {
            const active = target === item;
            return (
              <button
                key={item}
                type="button"
                role="radio"
                aria-checked={active}
                className="rounded-md px-2 py-1 text-[11px] font-medium transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)]"
                style={
                  active
                    ? {
                        background: "color-mix(in srgb, var(--app-accent) 12%, transparent)",
                        color: "var(--app-accent)",
                      }
                    : { color: "var(--app-text-secondary)" }
                }
                onClick={() => setTarget(item)}
              >
                {item === "append" ? t("injectionTargetAppend") : t("injectionTargetInitial")}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)]"
          style={{ borderColor: "var(--app-border)", color: "var(--app-text-secondary)" }}
          onClick={() => void injectLocalFile()}
        >
          <FileText className="h-3 w-3" />
          {t("injectFile")}
        </button>

        <label
          className="flex items-center gap-1.5 text-[11px]"
          style={{ color: "var(--app-text-secondary)" }}
        >
          <Sparkles className="h-3 w-3" />
          <select
            className="h-7 max-w-[180px] rounded-md border bg-background px-1.5 text-[11px] disabled:cursor-not-allowed disabled:opacity-40"
            value=""
            disabled={!projectPath || skills.length === 0}
            aria-label={t("injectSkill")}
            onChange={(event) => void injectSkill(event.target.value)}
          >
            <option value="">
              {!projectPath
                ? t("injectionNeedProject")
                : skills.length === 0
                  ? t("injectionNoSkills")
                  : t("injectSkill")}
            </option>
            {skills.map((skill) => (
              <option key={skill.name} value={skill.name} title={skill.preview}>
                {skill.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {draft.injection && (
        <div className="text-[10.5px]" style={{ color: "var(--app-text-tertiary)" }}>
          {t("injectionLast", {
            label: draft.injection.label,
            target:
              draft.injection.target === "append"
                ? t("injectionTargetAppend")
                : t("injectionTargetInitial"),
          })}
        </div>
      )}
    </div>
  );
}

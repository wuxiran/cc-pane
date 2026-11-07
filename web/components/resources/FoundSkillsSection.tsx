// 「Agent 中已有」：~/.claude/skills、~/.codex/skills、~/.agents/skills 里还没进资源库的技能。
// 导入是复制一份进资源库，原目录不动；之后按启动档开关。
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { toastErr, toastOk } from "@/lib/feedback";
import { skillLibraryService } from "@/services/skillLibraryService";
import { useSkillLibraryStore } from "@/stores/useSkillLibraryStore";
import type { FoundSkill, FoundSkillOrigin, SkillImportResult } from "@/types/skillLibrary";
import { translateError } from "@/utils";
import { handleErrorSilent } from "@/utils/errorHandler";

const ORIGIN_DIR: Record<FoundSkillOrigin, string> = {
  claude: "~/.claude/skills",
  codex: "~/.codex/skills",
  agents: "~/.agents/skills",
};

export default function FoundSkillsSection({ active }: { active: boolean }) {
  const { t } = useTranslation("settings");
  const importFound = useSkillLibraryStore((s) => s.importFound);
  const [found, setFound] = useState<FoundSkill[]>([]);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());

  const load = useCallback(() => {
    skillLibraryService.found().then(setFound).catch((error) => {
      setFound([]);
      handleErrorSilent(error, "list found skills");
    });
  }, []);

  useEffect(() => {
    if (!active) return;
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [active, load]);

  const report = (result: SkillImportResult) => {
    if (result.imported.length > 0) toastOk(t("skillLibrary.found.imported", { count: result.imported.length }));
    for (const item of result.failed) {
      const name = found.find((skill) => skill.key === item.key)?.name ?? item.key;
      toastErr(t("skillLibrary.found.importFailed", { name, error: item.error }));
    }
  };

  const run = async (keys: string[]) => {
    setBusy(new Set(keys));
    try {
      report(await importFound(keys));
      load();
    } catch (error) {
      toastErr(t("skillLibrary.actionFailed", { error: translateError(error) }));
    } finally {
      setBusy(new Set());
    }
  };

  if (found.length === 0) return null;

  return (
    <section className="mb-6" aria-label={t("resourceLibrary.agentTitle")} data-testid="found-skills-section">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-xs font-medium" style={{ color: "var(--app-text-secondary)" }}>{t("resourceLibrary.agentTitle")}</h2>
        <span className="mr-auto text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>{t("skillLibrary.found.hint")}</span>
        {found.length > 1 && (
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy.size > 0} onClick={() => void run(found.map((skill) => skill.key))} data-testid="found-import-all">
            {t("skillLibrary.found.importAll")}
          </Button>
        )}
      </div>
      <div className="divide-y rounded-lg border" style={{ borderColor: "var(--app-border)" }}>
        {found.map((skill) => (
          <div key={skill.key} className="flex items-center gap-3 px-3 py-2" data-testid="found-skill-row" data-resource-name={skill.name}>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[length:var(--text-row)] font-medium" style={{ color: "var(--app-text-primary)" }}>{skill.name}</span>
                <span className="text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>{ORIGIN_DIR[skill.origin]}</span>
                {skill.inLibraryAs && (
                  <span className="rounded-full border px-1.5 text-[length:var(--text-micro)] leading-4" style={{ color: "var(--app-text-tertiary)", borderColor: "var(--app-border)" }}>
                    {t("skillLibrary.found.sameName", { name: skill.inLibraryAs })}
                  </span>
                )}
              </div>
              {skill.description && <p className="truncate text-[length:var(--text-small)]" style={{ color: "var(--app-text-secondary)" }} title={skill.description}>{skill.description}</p>}
              {skill.isLink && skill.linkTarget && (
                <p className="truncate font-mono text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>{t("skillLibrary.found.linkedFrom", { path: skill.linkTarget })}</p>
              )}
            </div>
            <Button size="sm" variant="outline" className="h-7 shrink-0 text-xs" disabled={busy.has(skill.key)} onClick={() => void run([skill.key])} data-testid="found-import">
              {t("resourceLibrary.importAction")}
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}

// 安装卡：粘贴来源 → 查找 → 勾选候选 → 安装 N 个。装好的技能默认不开给任何启动档。
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { toastErr, toastOk, toastWarn } from "@/lib/feedback";
import { skillLibraryService } from "@/services/skillLibraryService";
import { useSkillLibraryStore } from "@/stores/useSkillLibraryStore";
import type { SkillInstallResult, SkillProbe } from "@/types/skillLibrary";
import { translateError } from "@/utils";
import { defaultProbePicks, gitLabel } from "./skillLibraryModel";

const FILTER_THRESHOLD = 8;

function probeSourceLabel(probe: SkillProbe): string {
  if (probe.kind === "github") return `github.com/${probe.source.replace(/^https?:\/\/github\.com\//, "")}`;
  if (probe.kind === "git") return gitLabel(probe.source);
  return probe.source;
}

export default function SkillInstallCard() {
  const { t } = useTranslation(["settings", "common"]);
  const install = useSkillLibraryStore((s) => s.install);
  const [source, setSource] = useState("");
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<SkillProbe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState("");
  const [installing, setInstalling] = useState(false);

  const find = async () => {
    const value = source.trim();
    if (!value || probing) return;
    setProbing(true);
    setError(null);
    setProbe(null);
    try {
      const found = await skillLibraryService.probe(value);
      setProbe(found);
      setPicked(defaultProbePicks(found.candidates));
      setFilter("");
    } catch (reason) {
      setError(translateError(reason));
    } finally {
      setProbing(false);
    }
  };

  const reset = () => {
    setProbe(null);
    setError(null);
    setPicked(new Set());
  };

  const report = (result: SkillInstallResult) => {
    if (result.installed.length > 0) toastOk(t("skillLibrary.install.installed", { count: result.installed.length }));
    if (result.had.length > 0) toastWarn(t("skillLibrary.install.had", { names: result.had.join(", ") }));
    for (const skip of result.skipped) toastWarn(t("skillLibrary.install.skipped", { name: skip.path, error: skip.reason }));
  };

  const submit = async () => {
    if (!probe || picked.size === 0) return;
    setInstalling(true);
    try {
      report(await install(probe.probeId, [...picked]));
      reset();
      setSource("");
    } catch (reason) {
      toastErr(t("skillLibrary.actionFailed", { error: translateError(reason) }));
    } finally {
      setInstalling(false);
    }
  };

  const fresh = useMemo(() => probe?.candidates.filter((candidate) => !candidate.have) ?? [], [probe]);
  const allPicked = fresh.length > 0 && fresh.every((candidate) => picked.has(candidate.path));
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const list = probe?.candidates ?? [];
    return needle ? list.filter((item) => `${item.name} ${item.description ?? ""} ${item.path}`.toLowerCase().includes(needle)) : list;
  }, [probe, filter]);

  const toggle = (path: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(path);
    else next.delete(path);
    setPicked(next);
  };

  return (
    <section className="mb-5 rounded-lg border p-3" style={{ borderColor: "var(--app-border)" }} data-testid="skill-install-card" aria-label={t("skillLibrary.install.title")}>
      <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); void find(); }}>
        <div className="relative min-w-0 flex-1">
          <Search size={13} aria-hidden="true" className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2" style={{ color: "var(--app-text-tertiary)" }} />
          <Input
            value={source}
            onChange={(event) => setSource(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape" && probe) reset(); }}
            placeholder={t("skillLibrary.install.placeholder")}
            aria-label={t("skillLibrary.install.title")}
            spellCheck={false}
            autoComplete="off"
            className="h-8 pl-7 font-mono text-xs"
            data-testid="skill-install-source"
          />
        </div>
        <Button type="submit" size="sm" className="h-8" disabled={probing || !source.trim()} data-testid="skill-install-find">
          {probing && <Loader2 size={12} className="mr-1 animate-spin" />}
          {probing ? t("skillLibrary.install.finding") : t("skillLibrary.install.find")}
        </Button>
      </form>

      {error && <p role="alert" className="mt-2 break-all text-xs" style={{ color: "var(--app-status-danger)" }}>{error}</p>}

      {probe && (
        <div className="mt-3" data-testid="skill-probe-result">
          {probe.tooBig.map((item) => (
            <p key={item.path} className="mb-1 text-xs" style={{ color: "var(--app-status-warning, var(--app-text-tertiary))" }}>
              {t("skillLibrary.install.tooBig", { name: item.path.split("/").pop() || probe.source, reason: item.reason })}
            </p>
          ))}
          {probe.candidates.length === 0 ? (
            <p className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("skillLibrary.install.none")}</p>
          ) : (
            <>
              <div className="mb-2 flex items-center gap-2">
                <span className="mr-auto truncate text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                  {t("skillLibrary.install.foundIn", { count: probe.candidates.length, source: probeSourceLabel(probe) })}
                </span>
                {fresh.length > 1 && (
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setPicked(new Set(allPicked ? [] : fresh.map((item) => item.path)))}>
                    {allPicked ? t("skillLibrary.install.selectNone") : t("skillLibrary.install.selectAll")}
                  </Button>
                )}
              </div>
              {probe.candidates.length > FILTER_THRESHOLD && (
                <Input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder={t("skillLibrary.install.filter")}
                  aria-label={t("skillLibrary.install.filter")}
                  className="mb-2 h-7 text-xs"
                />
              )}
              <div className="app-scrollbar max-h-72 divide-y overflow-y-auto rounded-md border" style={{ borderColor: "var(--app-border)" }}>
                {visible.map((candidate) => (
                  <label
                    key={candidate.path}
                    className="flex cursor-default items-start gap-2 px-3 py-2 text-xs data-[have=true]:opacity-60"
                    data-have={candidate.have ? "true" : undefined}
                    data-testid="skill-probe-candidate"
                  >
                    <Checkbox
                      className="mt-0.5"
                      checked={picked.has(candidate.path)}
                      disabled={candidate.have}
                      onCheckedChange={(checked) => toggle(candidate.path, checked === true)}
                      aria-label={candidate.name}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium" style={{ color: "var(--app-text-primary)" }}>{candidate.name}</span>
                      <span className="block truncate" style={{ color: "var(--app-text-tertiary)" }}>{candidate.description || candidate.path}</span>
                    </span>
                    {candidate.have ? (
                      <span className="shrink-0 text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>
                        {candidate.haveAs && candidate.haveAs !== candidate.name
                          ? t("skillLibrary.install.haveAs", { name: candidate.haveAs })
                          : t("skillLibrary.install.have")}
                      </span>
                    ) : candidate.installAs !== candidate.name ? (
                      <span className="shrink-0 text-[length:var(--text-micro)]" style={{ color: "var(--app-accent)" }} title={t("skillLibrary.install.renamedHint", { name: candidate.name, as: candidate.installAs })}>
                        {t("skillLibrary.install.installAs", { name: candidate.installAs })}
                      </span>
                    ) : null}
                  </label>
                ))}
              </div>
            </>
          )}
          <div className="mt-2 flex items-center justify-end gap-2">
            <span className="mr-auto text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>{t("skillLibrary.install.afterHint")}</span>
            <Button size="sm" variant="ghost" className="h-8" onClick={reset}>{t("common:cancel")}</Button>
            {probe.candidates.length > 0 && (
              <Button size="sm" className="h-8" disabled={picked.size === 0 || installing} onClick={() => void submit()} data-testid="skill-install-submit">
                {installing && <Loader2 size={12} className="mr-1 animate-spin" />}
                {installing ? t("skillLibrary.install.installing") : t("skillLibrary.install.submit", { count: picked.size })}
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

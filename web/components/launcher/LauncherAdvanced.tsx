// 启动器「高级」：运行环境/worktree/供应商、场景模板、参数、内容注入、目标布局、命令预览。
// 默认折叠；折叠时标题行列出**改过的项**，避免藏起来的设置悄悄生效。
import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { WorkspaceLaunchEnvironment } from "@/types";
import type { LauncherDraft } from "./launcherModel";

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[length:var(--text-micro)] font-semibold uppercase tracking-[0.09em] text-[var(--app-text-tertiary)]">{label}</div>
      {children}
    </div>
  );
}

/** 与默认值不同的高级项（给折叠标题行用）。 */
export function useAdvancedSummary(draft: LauncherDraft, environment: WorkspaceLaunchEnvironment): string[] {
  const { t } = useTranslation("launcher");
  const items: string[] = [];
  if (environment !== "local") items.push(t(`env.${environment}`));
  if (draft.worktree?.enabled) items.push(t("summaryWorktree"));
  if (draft.providerSelection !== "inherit" && draft.cliTool !== "none") items.push(t(`providerSelection.${draft.providerSelection}`));
  if (draft.scenarioId && draft.scenarioId !== "default") items.push(t(`scenario.${draft.scenarioId as "coding"}`));
  if (draft.effort) items.push(`${t("effort")} ${t(`effortLevel.${draft.effort}`)}`);
  if (draft.skipMcp) items.push(t("skipMcp"));
  if (draft.verbose) items.push(t("verbose"));
  if (draft.maxTurns) items.push(`${t("maxTurns")} ${draft.maxTurns}`);
  if (draft.appendSystemPrompt.trim() && (!draft.scenarioId || draft.scenarioId === "default")) items.push(t("appendSystemPrompt"));
  if (draft.injection) items.push(t("summaryInjection"));
  if (draft.targetLayoutId) items.push(t("targetLayout"));
  return items;
}

interface LauncherAdvancedProps {
  summary: string[];
  environment: ReactNode;
  scenario: ReactNode;
  options: ReactNode;
  injection: ReactNode;
  layout: ReactNode;
  preview: ReactNode;
}

export default function LauncherAdvanced({ summary, environment, scenario, options, injection, layout, preview }: LauncherAdvancedProps) {
  const { t } = useTranslation("launcher");
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-2xl border border-[var(--app-border)]">
      <button
        type="button"
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 rounded-2xl px-4 py-2.5 text-left transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)]"
        onClick={() => setExpanded((value) => !value)}
      >
        <ChevronRight className={cn("size-4 shrink-0 text-[var(--app-text-tertiary)] transition-transform duration-[var(--dur-fast)]", expanded && "rotate-90")} aria-hidden="true" />
        <span className="shrink-0 text-[length:var(--text-small)] font-medium text-[var(--app-text-primary)]">{t("advanced")}</span>
        <span className="min-w-0 truncate text-[length:var(--text-small)] text-[var(--app-text-tertiary)]" data-testid="launcher-advanced-summary">
          {summary.length > 0 ? summary.join(" · ") : t("advancedDefault")}
        </span>
      </button>
      {expanded && (
        <div className="flex flex-col gap-5 border-t border-[var(--app-border)] px-4 py-4">
          <Section label={t("launchSettings")}>{environment}</Section>
          <Section label={t("sectionScenario")}>{scenario}</Section>
          <Section label={t("sectionOptions")}>{options}</Section>
          <Section label={t("sectionInjection")}>{injection}</Section>
          <Section label={t("sectionLayout")}>{layout}</Section>
          {preview}
        </div>
      )}
    </div>
  );
}

// 中转纯度详情：最近一次报告（每个型号的结论和证据）+ 开始 / 重新检测 / 取消。
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { toastErr } from "@/lib/feedback";
import type { PurityFinding, PurityModelReport, PurityReport } from "@/services";
import { useChannelPurityStore } from "@/stores/useChannelPurityStore";
import type { Provider } from "@/types/provider";
import { getErrorCode, translateError } from "@/utils";
import { formatFullTime } from "@/utils/format";
import { STATE_COLOR, StateIcon, useEnsureLoaded } from "./purityShared";

/** 详情弹窗。`accountId` 指定用哪个账号检测（标签页右键时是这次启动的账号），不给用默认账号。 */
export default function PurityDialog({ provider, accountId, onClose }: { provider: Provider; accountId?: string | null; onClose: () => void }) {
  const { t } = useTranslation("providers");
  useEnsureLoaded();
  const report = useChannelPurityStore((s) => s.reports[provider.id]);
  const job = useChannelPurityStore((s) => s.job);
  const start = useChannelPurityStore((s) => s.start);
  const cancel = useChannelPurityStore((s) => s.cancel);
  const mine = job?.providerId === provider.id ? job : null;
  const running = job?.stage === "running";
  const runningMine = mine?.stage === "running";

  const handleStart = async () => {
    try {
      await start(provider.id, accountId);
    } catch (error) {
      const code = getErrorCode(error);
      toastErr(code?.startsWith("PURITY_") ? t(`purity.error.${code}` as never) : t("purity.error.failed", { error: translateError(error) }));
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-2xl" data-testid="purity-dialog">
        <DialogHeader>
          <DialogTitle>{t("purity.dialogTitle", { name: provider.name })}</DialogTitle>
          <DialogDescription>{t("purity.intro")}</DialogDescription>
        </DialogHeader>

        {runningMine ? (
          <div className="flex flex-col gap-1.5" role="status">
            <Progress value={mine.total > 0 ? Math.round((mine.done / mine.total) * 100) : null} aria-label={t("purity.running", { done: mine.done, total: mine.total })} className="h-1.5" />
            <span className="text-[length:var(--text-small)] text-[var(--app-text-secondary)]">
              {mine.total > 0 ? t("purity.running", { done: mine.done, total: mine.total }) : t("purity.preparing")}
              {mine.currentModel ? ` · ${t("purity.runningModel", { model: mine.currentModel })}` : ""}
            </span>
          </div>
        ) : mine?.stage === "error" && mine.error ? (
          <p role="alert" className="m-0 break-words text-[length:var(--text-small)] text-[var(--app-status-danger)]">
            {mine.error.startsWith("PURITY_") ? t(`purity.error.${mine.error}` as never) : t("purity.error.failed", { error: mine.error })}
          </p>
        ) : null}

        {report && <ReportView report={report} />}

        <p className="m-0 text-[length:var(--text-small)] text-[var(--app-text-tertiary)]">{t("purity.disclaimer")}</p>

        <DialogFooter>
          {runningMine ? (
            <Button variant="outline" onClick={() => void cancel()}>{t("purity.cancel")}</Button>
          ) : (
            <Button disabled={running} onClick={() => void handleStart()}>{report ? t("purity.recheck") : t("purity.start")}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReportView({ report }: { report: PurityReport }) {
  const { t } = useTranslation("providers");
  return (
    <div className="flex min-h-0 flex-col gap-2" data-testid="purity-report">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 text-[length:var(--text-row)] font-medium" style={{ color: STATE_COLOR[report.verdict] }}>
          <StateIcon state={report.verdict} size={14} />
          {t(`purity.verdict.${report.verdict}`)}
        </span>
        <span className="text-[length:var(--text-small)] text-[var(--app-text-tertiary)]">
          {t("purity.checkedAt", { time: formatFullTime(report.checkedAt), host: report.host })} · {t(`purity.protocol.${report.protocol}`)}
        </span>
      </div>
      {report.findings.length > 0 && (
        <div className="rounded-md border border-[var(--app-border)] px-3 py-2">
          <div className="text-[length:var(--text-small)] font-medium text-[var(--app-text-primary)]">{t("purity.batchTitle")}</div>
          <FindingList findings={report.findings} />
        </div>
      )}
      <ul className="app-scrollbar m-0 flex max-h-[50vh] list-none flex-col gap-2 overflow-y-auto p-0">
        {report.models.map((model) => <ModelRow key={model.model} model={model} />)}
      </ul>
    </div>
  );
}

function ModelRow({ model }: { model: PurityModelReport }) {
  const { t } = useTranslation("providers");
  return (
    <li className="rounded-md border border-[var(--app-border)] px-3 py-2" data-testid="purity-model" data-verdict={model.verdict}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[length:var(--text-small)] text-[var(--app-text-primary)]">{model.model}</span>
        <span className="inline-flex items-center gap-1 text-[length:var(--text-small)]" style={{ color: STATE_COLOR[model.verdict] }}>
          <StateIcon state={model.verdict} size={12} />
          {t(`purity.verdict.${model.verdict}`)}
        </span>
        {model.promptTokens !== undefined && (
          <span className="ms-auto text-[length:var(--text-small)] tabular-nums text-[var(--app-text-tertiary)]">
            {t("purity.promptTokens", { count: model.promptTokens })}
          </span>
        )}
      </div>
      {model.selfReport && (
        <div className="mt-0.5 truncate text-[length:var(--text-small)] text-[var(--app-text-tertiary)]" title={model.selfReport}>
          {t("purity.selfReport", { text: model.selfReport })}
        </div>
      )}
      {model.findings.length > 0 ? <FindingList findings={model.findings} /> : null}
    </li>
  );
}

function FindingList({ findings }: { findings: PurityFinding[] }) {
  const { t } = useTranslation("providers");
  return (
    <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
      {findings.map((finding, index) => {
        const color = ["hidden_prefix", "echoed_injection", "fishing_admitted", "batch_downgrade"].includes(finding.code)
          ? "var(--app-status-danger)"
          : ["new_params_rejected", "request_failed", "self_report_mismatch"].includes(finding.code)
            ? "var(--app-text-tertiary)"
            : "var(--app-status-warning)";
        // 数字和简短说明直接拼进句子；回复片段单独放在下面。
        const inline = finding.code === "hidden_prefix" || finding.code === "nonstandard_fields" || finding.code === "batch_downgrade" || finding.code === "response_model_mismatch";
        return (
          <li key={`${finding.code}-${index}`} className="text-[length:var(--text-small)]" data-finding={finding.code}>
            <span style={{ color }}>{t(`purity.finding.${finding.code}`, { detail: finding.detail ?? "" })}</span>
            {!inline && finding.detail && (
              <pre className="m-0 mt-0.5 max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded bg-[var(--app-hover)] px-2 py-1 font-mono text-[length:var(--text-nano)] text-[var(--app-text-secondary)]">
                {finding.detail}
              </pre>
            )}
          </li>
        );
      })}
    </ul>
  );
}

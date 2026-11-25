// 资源库 · 组件 · 飞书 CLI：四步——安装 lark-cli、创建飞书应用、登录授权、把官方 Skills 装进技能库。
// 2、3 两步要用户确认：后端在后台跑命令并抠出授权链接，这里画成二维码给飞书 App 扫，
// 也可以点按钮在浏览器里打开（lark-cli 在终端里打的也是同一个链接的二维码）。
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useTranslation } from "react-i18next";
import { Check, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { toastErr } from "@/lib/feedback";
import { feishuCliService, type FeishuJob, type FeishuJobKind, type FeishuStatus } from "@/services";
import { isTauriRuntime } from "@/services/runtime";
import { translateError } from "@/utils";
import { handleErrorSilent } from "@/utils/errorHandler";
import { openExternalUrl } from "./libraryChrome";

const POLL_MS = 1000;

export default function FeishuCliCard({ active }: { active: boolean }) {
  const { t } = useTranslation("settings");
  const [status, setStatus] = useState<FeishuStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!isTauriRuntime()) return;
    try {
      setStatus(await feishuCliService.status());
    } catch (cause) {
      handleErrorSilent(cause, "feishu cli status");
    }
  }, []);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  const job = status?.job ?? null;
  const running = job?.stage === "running";
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, load]);

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      toastErr(t("feishuCli.actionFailed", { error: translateError(cause) }));
    } finally {
      setBusy(false);
      await load();
    }
  };

  if (!status) return null;

  const loggedIn = status.identity === "user";
  const skillsDone = status.skillsInstalled.length;
  const skillsComplete = skillsDone >= status.skillsTotal;
  const disabled = busy || running;
  const jobFor = (kind: FeishuJobKind) => (job?.kind === kind ? job : null);

  return (
    <section className="rounded-lg border px-3 py-2.5" style={{ borderColor: "var(--app-border)" }} aria-label={t("feishuCli.name")} data-testid="feishu-cli-component">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[length:var(--text-row)] font-medium" style={{ color: "var(--app-text-primary)" }}>{t("feishuCli.name")}</span>
        {status.version && <span className="font-mono text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>v{status.version}</span>}
        <button type="button" className="ms-auto inline-flex items-center gap-1 text-[length:var(--text-micro)] hover:underline" style={{ color: "var(--app-text-tertiary)" }} onClick={() => void openExternalUrl("https://github.com/larksuite/cli")}>
          {t("feishuCli.homepage")}
          <ExternalLink size={11} aria-hidden="true" />
        </button>
      </div>
      <p className="m-0 mt-0.5 text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>{t("feishuCli.desc")}</p>

      <ol className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
        <Step
          index={1}
          done={status.installed}
          title={t("feishuCli.stepInstall")}
          state={status.installed ? t("feishuCli.installed", { version: status.version ?? "?" }) : status.npmFound ? null : t("feishuCli.npmMissing")}
          action={
            <Button size="sm" variant={status.installed ? "ghost" : "default"} className="h-7 text-xs" disabled={disabled || !status.npmFound} onClick={() => void act(() => feishuCliService.install())}>
              {status.installed ? t("feishuCli.update") : t("feishuCli.install")}
            </Button>
          }
          job={jobFor("install")}
          onCancel={() => void act(() => feishuCliService.cancel())}
        />
        <Step
          index={2}
          done={status.configured}
          title={t("feishuCli.stepConfig")}
          state={status.configured ? t("feishuCli.configured", { appId: status.appId ?? "" }) : null}
          action={status.installed && (
            <Button size="sm" variant={status.configured ? "ghost" : "default"} className="h-7 text-xs" disabled={disabled} onClick={() => void act(() => feishuCliService.start("config"))}>
              {status.configured ? t("feishuCli.reconfigure") : t("feishuCli.configure")}
            </Button>
          )}
          job={jobFor("config")}
          onCancel={() => void act(() => feishuCliService.cancel())}
        />
        <Step
          index={3}
          done={loggedIn}
          title={t("feishuCli.stepLogin")}
          state={loggedIn ? t("feishuCli.loggedIn") : status.identity === "bot" ? t("feishuCli.botOnly") : null}
          action={status.configured && (loggedIn ? (
            <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={disabled} onClick={() => void act(() => feishuCliService.logout())}>{t("feishuCli.logout")}</Button>
          ) : (
            <Button size="sm" className="h-7 text-xs" disabled={disabled} onClick={() => void act(() => feishuCliService.start("login"))}>{t("feishuCli.login")}</Button>
          ))}
          job={jobFor("login")}
          onCancel={() => void act(() => feishuCliService.cancel())}
        />
        <Step
          index={4}
          done={skillsComplete}
          title={t("feishuCli.stepSkills")}
          state={t("feishuCli.skillsCount", { done: skillsDone, total: status.skillsTotal })}
          action={!skillsComplete && (
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={disabled} onClick={() => void act(() => feishuCliService.installSkills())}>
              {skillsDone > 0 ? t("feishuCli.skillsComplete") : t("feishuCli.skillsInstall")}
            </Button>
          )}
          job={jobFor("skills")}
          onCancel={() => void act(() => feishuCliService.cancel())}
        />
      </ol>
      <p className="m-0 mt-2 text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>{t("feishuCli.skillsHint")}</p>
    </section>
  );
}

function Step({
  index,
  done,
  title,
  state,
  action,
  job,
  onCancel,
}: {
  index: number;
  done: boolean;
  title: string;
  state: string | null;
  action: ReactNode;
  job: FeishuJob | null;
  onCancel: () => void;
}) {
  return (
    <li className="flex flex-col gap-1" data-testid={`feishu-step-${index}`} data-done={done ? "true" : undefined}>
      <div className="flex flex-wrap items-center gap-2">
        <span
          aria-hidden="true"
          className="flex size-4 shrink-0 items-center justify-center rounded-full border text-[length:var(--text-micro)]"
          style={{ borderColor: done ? "var(--app-status-success)" : "var(--app-text-tertiary)", color: done ? "var(--app-status-success)" : "var(--app-text-tertiary)" }}
        >
          {done ? <Check size={10} /> : index}
        </span>
        <span className="text-[length:var(--text-small)]" style={{ color: "var(--app-text-primary)" }}>{title}</span>
        {state && <span className="text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>{state}</span>}
        <span className="ms-auto">{action}</span>
      </div>
      {job && <JobLine job={job} onCancel={onCancel} />}
    </li>
  );
}

function JobLine({ job, onCancel }: { job: FeishuJob; onCancel: () => void }) {
  const { t } = useTranslation("settings");
  if (job.stage === "done" || job.stage === "cancelled") return null;
  if (job.stage === "error") {
    return (
      <p role="alert" className="m-0 ms-6 whitespace-pre-wrap break-words text-[length:var(--text-micro)]" style={{ color: "var(--app-status-danger)" }}>
        {t("feishuCli.failed", { error: job.error ?? "" })}
      </p>
    );
  }
  const waitingBrowser = job.kind === "config" || job.kind === "login";
  const authUrl = waitingBrowser ? job.url : null;
  return (
    <div className="ms-6 flex flex-col gap-2" data-testid="feishu-job">
      <div className="flex flex-wrap items-center gap-2 text-[length:var(--text-micro)]" style={{ color: "var(--app-text-secondary)" }}>
        {job.kind === "skills" && job.total > 0 ? (
          <Progress value={Math.round((job.done / job.total) * 100)} aria-label={t("feishuCli.skillsProgress", { done: job.done, total: job.total })} className="h-1.5 w-32" />
        ) : (
          <Loader2 size={12} className="animate-spin" aria-hidden="true" />
        )}
        <span role="status">
          {job.kind === "skills"
            ? t("feishuCli.skillsProgress", { done: job.done, total: job.total })
            : waitingBrowser
              ? authUrl ? t("feishuCli.waitingScan") : t("feishuCli.preparing")
              : t("feishuCli.installing")}
        </span>
        <Button size="sm" variant="ghost" className="h-6 px-2 text-[length:var(--text-micro)]" onClick={onCancel}>{t("feishuCli.cancel")}</Button>
      </div>
      {authUrl && (
        <figure className="m-0 flex flex-wrap items-end gap-3" data-testid="feishu-auth-qr" data-payload={authUrl}>
          {/* 深色模块 + 浅色静区：暗色主题下也保持可扫 */}
          <div className="rounded-md bg-white p-2">
            <QRCodeSVG value={authUrl} size={148} level="M" bgColor="#ffffff" fgColor="#000000" title={t("feishuCli.qrTitle")} />
          </div>
          <figcaption className="flex flex-col items-start gap-1 text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>
            <span>{t("feishuCli.qrCaption")}</span>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void openExternalUrl(authUrl)}>
              <ExternalLink size={12} aria-hidden="true" />
              {t("feishuCli.openInBrowser")}
            </Button>
          </figcaption>
        </figure>
      )}
    </div>
  );
}

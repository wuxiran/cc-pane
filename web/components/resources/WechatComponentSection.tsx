// 资源库 · 组件 · 微信：随 CC-Panes 附带的 cc-wechat-mcp。
// 启用后就是一条名为 wechat 的共享 MCP，出现在 MCP 页列表里，注入哪些会话仍由启动档开关决定。
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { toastErr } from "@/lib/feedback";
import {
  wechatComponentService,
  WECHAT_SERVER_NAME,
  type WechatCheckResult,
  type WechatComponentStatus,
  type WechatRemote,
} from "@/services";
import { isTauriRuntime } from "@/services/runtime";
import { useSharedMcpStore } from "@/stores/useSharedMcpStore";
import { translateError } from "@/utils";
import { handleErrorSilent } from "@/utils/errorHandler";
import { mcpStatusOf, type McpStatusLevel } from "./resourceCenterModel";
import WechatRemoteDialog from "./WechatRemoteDialog";

const STATUS_COLOR: Record<McpStatusLevel, string> = {
  running: "var(--app-status-success)",
  starting: "var(--app-accent)",
  stopped: "var(--app-text-tertiary)",
  failed: "var(--app-status-danger)",
};
/** 隧道 / 进程刚起来时端口还没就绪，稍等再检测 */
const CHECK_DELAY_MS = 1500;

type CheckState = { kind: "idle" } | { kind: "checking" } | { kind: "done"; result: WechatCheckResult } | { kind: "error"; message: string };

export default function WechatComponentSection({ active }: { active: boolean }) {
  const { t } = useTranslation("settings");
  const fetchShared = useSharedMcpStore((s) => s.fetchStatus);
  // 运行状态跟着页面的共享 MCP 轮询走，不另起定时器
  const shared = useSharedMcpStore((s) => s.servers.find((server) => server.name === WECHAT_SERVER_NAME) ?? null);
  const [status, setStatus] = useState<WechatComponentStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });
  const [remoteOpen, setRemoteOpen] = useState(false);

  const load = useCallback(() => {
    if (!isTauriRuntime()) return;
    wechatComponentService.status().then(setStatus).catch((cause) => handleErrorSilent(cause, "wechat component status"));
  }, []);

  useEffect(() => {
    if (active) load();
  }, [active, load]);

  // 用户在上方列表里删掉 / 新建了 wechat 条目时，重新判断模式。
  // 自己的操作进行中不算：那时列表和状态本来就会短暂对不上，操作结果会带回新状态。
  const sharedPresent = shared !== null;
  useEffect(() => {
    if (active && !busy && status && sharedPresent !== (status.mode !== "off")) load();
  }, [active, busy, sharedPresent, status, load]);

  const runCheck = useCallback(async () => {
    setCheck({ kind: "checking" });
    try {
      setCheck({ kind: "done", result: await wechatComponentService.check() });
    } catch (cause) {
      setCheck({ kind: "error", message: translateError(cause) });
    }
  }, []);

  // fromDialog：对话框自己显示错误，不再弹 toast，异常抛回给它
  const apply = async (action: () => Promise<WechatComponentStatus>, thenCheck: boolean, fromDialog = false) => {
    setBusy(true);
    setCheck({ kind: "idle" });
    try {
      setStatus(await action());
      await fetchShared();
      // 不等检测：远端没响应时最多卡 30 秒，不该拖住按钮和对话框
      if (thenCheck) window.setTimeout(() => void runCheck(), CHECK_DELAY_MS);
    } catch (cause) {
      if (fromDialog) throw new Error(translateError(cause));
      toastErr(t("wechatComponent.actionFailed", { error: translateError(cause) }));
    } finally {
      setBusy(false);
    }
  };
  const enableLocal = () => apply(() => wechatComponentService.enableLocal(), true);
  const disable = () => apply(() => wechatComponentService.disable(), false);
  const connectRemote = (remote: WechatRemote) => apply(() => wechatComponentService.enableRemote(remote), true, true);

  if (!status) return null;

  const mode = status.mode;
  const level = shared ? mcpStatusOf(shared.status).level : null;
  const port = shared?.config.port ?? status.server?.config.port;

  const detail =
    mode === "local" ? t("wechatComponent.modeLocal", { port })
      : mode === "remote" && status.remote ? t("wechatComponent.modeRemote", { target: status.remote.target, port: status.remote.remotePort })
        : mode === "custom" ? t("wechatComponent.modeCustom")
          : status.localSupported ? null : t("wechatComponent.remoteOnlyHint");

  return (
    <section aria-label={t("wechatComponent.name")}>
      <div className="rounded-lg border px-3 py-2.5" style={{ borderColor: "var(--app-border)" }} data-testid="wechat-component" data-mode={mode}>
        <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
          <div className="min-w-48 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[length:var(--text-row)] font-medium" style={{ color: "var(--app-text-primary)" }}>{t("wechatComponent.name")}</span>
              {level && mode !== "off" && (
                <span className="text-[length:var(--text-micro)]" style={{ color: STATUS_COLOR[level] }}>{t(`mcpStatus.${level}`)}</span>
              )}
            </div>
            <p className="m-0 mt-0.5 text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>{t("wechatComponent.desc")}</p>
            {detail && <p className="m-0 mt-0.5 text-[length:var(--text-micro)]" style={{ color: "var(--app-text-secondary)" }}>{detail}</p>}
            {mode === "local" && !status.binaryFound && (
              <p role="alert" className="m-0 mt-0.5 text-[length:var(--text-micro)]" style={{ color: "var(--app-status-danger)" }}>{t("wechatComponent.binaryMissing")}</p>
            )}
            <CheckLine state={check} />
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {(mode === "local" || mode === "remote") && (
              <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy || check.kind === "checking"} onClick={() => void runCheck()}>
                {check.kind === "checking" ? t("wechatComponent.checking") : t("wechatComponent.check")}
              </Button>
            )}
            {status.localSupported && mode !== "local" && (
              <Button size="sm" variant={mode === "off" ? "default" : "outline"} className="h-7 text-xs" disabled={busy || !status.binaryFound} onClick={() => void enableLocal()}>
                {mode === "off" ? t("wechatComponent.enableLocal") : t("wechatComponent.switchToBuiltin")}
              </Button>
            )}
            {mode !== "local" && (
              <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => setRemoteOpen(true)}>
                {mode === "remote" ? t("wechatComponent.editRemote") : t("wechatComponent.connectRemote")}
              </Button>
            )}
            {/* 自定义条目是用户手配的，不在这里删，免得一键丢掉他的配置 */}
            {(mode === "local" || mode === "remote") && (
              <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={busy} onClick={() => void disable()}>
                {t("wechatComponent.disable")}
              </Button>
            )}
          </div>
        </div>
      </div>
      <WechatRemoteDialog open={remoteOpen} remote={status.remote} onOpenChange={setRemoteOpen} onConnect={async (remote) => { await connectRemote(remote); }} />
    </section>
  );
}

function CheckLine({ state }: { state: CheckState }) {
  const { t } = useTranslation("settings");
  if (state.kind === "idle" || state.kind === "checking") return null;
  const failed = state.kind === "error" ? state.message : state.result.ok ? null : state.result.error ?? t("wechatComponent.unknownError");
  const text = failed
    ? t("wechatComponent.checkFailed", { error: failed })
    : state.kind === "done"
      ? t("wechatComponent.checkOk", { pid: state.result.pid ?? "?", count: state.result.message_dbs?.length ?? 0 })
      : "";
  return (
    <p
      role={failed ? "alert" : "status"}
      className="m-0 mt-1 break-words text-[length:var(--text-micro)]"
      style={{ color: failed ? "var(--app-status-danger)" : "var(--app-status-success)" }}
      data-testid="wechat-check-result"
    >
      {text}
    </p>
  );
}

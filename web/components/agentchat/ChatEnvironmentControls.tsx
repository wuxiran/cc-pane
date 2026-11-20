// 启动环境弹层里的「运行环境」：本地 + 每台已保存的 SSH 机器（设备视图同一份列表）。
// 选中机器后填远端目录，并显示一次连通/系统检测结果。选择按对话存（useAgentChatRemoteStore）。
import { useEffect } from "react";
import { Loader2, Monitor, Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSshMachinesStore } from "@/stores/useSshMachinesStore";
import { useAgentChatRemoteStore } from "@/stores/useAgentChatRemoteStore";
import type { SshMachine } from "@/types";
import { remoteUnsupportedReason, selectRemoteMachine } from "./remoteTarget";

const OPTION_CLASS =
  "flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors enabled:hover:bg-[var(--app-hover)] disabled:opacity-50 data-[current=true]:bg-[var(--app-active-bg)] data-[current=true]:text-[var(--app-text-primary)]";

interface ChatEnvironmentControlsProps {
  chatId: string;
  disabled?: boolean;
}

export default function ChatEnvironmentControls({ chatId, disabled }: ChatEnvironmentControlsProps) {
  const { t } = useTranslation("launcher");
  const machines = useSshMachinesStore((state) => state.machines);
  const load = useSshMachinesStore((state) => state.load);
  const target = useAgentChatRemoteStore((state) => state.targets[chatId] ?? null);
  const setRemoteCwd = useAgentChatRemoteStore((state) => state.setRemoteCwd);
  useEffect(() => { void load(); }, [load]);

  const reasonText = (machine: SshMachine) => {
    const reason = remoteUnsupportedReason(machine);
    if (reason === "password") return t("remoteEnvPasswordUnsupported");
    if (reason === "routed") return t("remoteEnvRoutedUnsupported");
    return null;
  };

  return (
    <div className="space-y-2">
      <div role="radiogroup" aria-label={t("environment")}
        className="max-h-48 space-y-0.5 overflow-y-auto rounded-lg border border-[var(--app-border)] p-1">
        <button type="button" role="radio" aria-checked={!target} data-current={!target}
          disabled={disabled} className={OPTION_CLASS} onClick={() => selectRemoteMachine(chatId, null)}>
          <Monitor className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{t("env.local")}</span>
        </button>
        {machines.map((machine) => {
          const reason = reasonText(machine);
          const current = target?.machineId === machine.id;
          return (
            <button key={machine.id} type="button" role="radio" aria-checked={current} data-current={current}
              disabled={disabled || reason !== null} className={OPTION_CLASS}
              onClick={() => { if (!current) selectRemoteMachine(chatId, machine); }}>
              <Server className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="truncate text-[var(--app-text-primary)]">{machine.name}</span>
                  <span className="truncate text-[var(--app-text-tertiary)]">{machine.host}</span>
                </span>
                {reason && <span className="block text-[var(--app-text-tertiary)]">{reason}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {machines.length === 0 && <p className="text-xs text-[var(--app-text-tertiary)]">{t("remoteEnvEmpty")}</p>}
      {target && (
        <label className="block space-y-1.5 text-xs">
          <span>{t("remoteEnvDirectory")}</span>
          <input value={target.cwd} aria-label={t("remoteEnvDirectory")} disabled={disabled}
            spellCheck={false} className="h-8 w-full rounded-md border bg-background px-2 font-mono text-xs"
            onChange={(event) => setRemoteCwd(chatId, event.target.value)} />
          <RemoteProbeStatus chatId={chatId} />
        </label>
      )}
    </div>
  );
}

function RemoteProbeStatus({ chatId }: { chatId: string }) {
  const { t } = useTranslation("launcher");
  const target = useAgentChatRemoteStore((state) => state.targets[chatId] ?? null);
  if (!target) return null;
  const { probe } = target;
  if (probe.status === "checking") {
    return (
      <span role="status" className="flex items-center gap-1.5 text-[var(--app-text-tertiary)]">
        <Loader2 className="size-3 animate-spin" aria-hidden="true" /> {t("remoteEnvChecking")}
      </span>
    );
  }
  if (probe.status === "unreachable") {
    return (
      <span role="status" data-testid="remote-probe-error" className="block break-words text-[var(--app-status-warning)]">
        {t("remoteEnvUnreachable", { message: probe.message })}
      </span>
    );
  }
  return (
    <span role="status" className="block text-[var(--app-text-tertiary)]">
      {t("remoteEnvReachable", { os: target.os || t("remoteEnvUnknownOs") })}
    </span>
  );
}

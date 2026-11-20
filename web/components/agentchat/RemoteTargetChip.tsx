// 远程会话顶栏 chip：替代本地工作空间切换菜单，只展示「机器 · 远端目录」。
// 远程会话不提供切目录（换目录 = 在远端重开会话，由启动页的运行环境负责）。
import { Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentChatRemoteTarget } from "@/stores/useAgentChatRemoteStore";

export default function RemoteTargetChip({ target }: { target: AgentChatRemoteTarget }) {
  const { t } = useTranslation("panes");
  return (
    <span
      data-testid="remote-target-chip"
      title={t("agentChatRemoteTargetTip", { host: target.host, path: target.cwd })}
      className="flex h-6 max-w-44 items-center gap-1 rounded-md border border-[var(--app-border)] bg-[var(--app-overlay)] px-1.5 text-[length:var(--text-caption)] text-[var(--app-text-secondary)]"
    >
      <Server className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{t("agentChatRemoteTarget", { machine: target.machineName, path: target.cwd })}</span>
    </span>
  );
}

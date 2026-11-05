// 「Agent 中已有」：Agent 自己配置里还没进资源库的 MCP。只读，导入后归资源库管，原文件不动。
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { toastErr, toastOk } from "@/lib/feedback";
import { sharedMcpService } from "@/services";
import { useSharedMcpStore } from "@/stores/useSharedMcpStore";
import type { AgentMcpServer } from "@/types/shared-mcp";
import { translateError } from "@/utils";
import { handleErrorSilent } from "@/utils/errorHandler";
import { commandLine } from "@/components/settings/mcpCommandLine";

const AGENT_LABEL: Record<string, string> = { claude: "Claude Code", codex: "Codex" };

export default function AgentMcpServersSection({ active }: { active: boolean }) {
  const { t } = useTranslation("settings");
  const fetchStatus = useSharedMcpStore((s) => s.fetchStatus);
  const startServer = useSharedMcpStore((s) => s.startServer);
  const [servers, setServers] = useState<AgentMcpServer[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    sharedMcpService.listAgentServers().then(setServers).catch((error) => {
      setServers([]);
      handleErrorSilent(error, "list agent mcp servers");
    });
  }, []);

  useEffect(() => {
    if (!active) return;
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [active, load]);

  const handleImport = async (name: string) => {
    setBusy(name);
    try {
      await sharedMcpService.importAgentServer(name);
      await startServer(name);
      await fetchStatus();
      toastOk(t("resourceLibrary.agentImported", { name }));
      load();
    } catch (error) {
      toastErr(t("sharedMcp.importFailed", { error: translateError(error) }));
    } finally {
      setBusy(null);
    }
  };

  if (servers.length === 0) return null;

  return (
    <section className="mt-6" aria-label={t("resourceLibrary.agentTitle")} data-testid="agent-mcp-section">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xs font-medium" style={{ color: "var(--app-text-secondary)" }}>{t("resourceLibrary.agentTitle")}</h2>
        <span className="text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>{t("resourceLibrary.agentHint")}</span>
      </div>
      <div className="divide-y rounded-lg border" style={{ borderColor: "var(--app-border)" }}>
        {servers.map((server) => (
          <div key={server.name} className="flex items-center gap-3 px-3 py-2" data-testid="agent-mcp-row">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[length:var(--text-row)] font-medium" style={{ color: "var(--app-text-primary)" }}>{server.name}</span>
                <span className="text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>
                  {server.agents.map((agent) => AGENT_LABEL[agent] ?? agent).join(" · ")}
                </span>
              </div>
              <p className="truncate font-mono text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>
                {server.url ?? commandLine({ command: server.command ?? "", args: server.args })}
              </p>
            </div>
            <Button size="sm" variant="outline" className="h-7 shrink-0 text-xs" disabled={busy === server.name} onClick={() => void handleImport(server.name)}>
              {t("resourceLibrary.importAction")}
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}

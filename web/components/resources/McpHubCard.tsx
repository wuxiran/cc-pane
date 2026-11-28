// 资源库 · MCP 顶部的 Hub 卡片（docs/113）：ccpanes-hub 是共享 MCP 的统一入口，这里让它可见。
// 端点状态 + 背后聚合了几台服务器 / 已缓存多少工具 + 哪些启动档在用 Hub 投递。
// 没有任何共享服务器、或拿不到状态（Web 壳没有 orchestrator）时整张卡隐藏。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Network } from "lucide-react";
import { sharedMcpService } from "@/services";
import type { LaunchProfile } from "@/types";
import type { McpHubStatus } from "@/types/shared-mcp";
import { profileName } from "./libraryChrome";
import { hubFallsBackForProfile } from "./resourceCenterModel";

const POLL_MS = 5000;

/** 选了 Hub 投递、MCP 没全关的启动档（是否真正走 Hub 还取决于 CLI / 运行时，见启动档卡片）。 */
export function hubProfiles(profiles: readonly LaunchProfile[]): LaunchProfile[] {
  return profiles.filter((profile) => profile.mcpPolicy.delivery === "hub" && profile.mcpPolicy.mode !== "disabled");
}

export function hubSummary(status: McpHubStatus) {
  const routable = status.servers.filter((server) => server.routable);
  const live = routable.filter((server) => server.running);
  const known = live.filter((server) => server.toolCount !== null);
  return {
    servers: live.length,
    tools: known.reduce((sum, server) => sum + (server.toolCount ?? 0), 0),
    toolsPending: known.length < live.length,
    stopped: routable.filter((server) => !server.running).map((server) => server.name),
    direct: status.servers.filter((server) => !server.routable).map((server) => server.name),
  };
}

export default function McpHubCard({ active, hasShared, profiles }: { active: boolean; hasShared: boolean; profiles: readonly LaunchProfile[] }) {
  const { t } = useTranslation("settings");
  const [status, setStatus] = useState<McpHubStatus | null>(null);

  useEffect(() => {
    if (!active || !hasShared) return;
    let cancelled = false;
    const refresh = () => {
      sharedMcpService.getHubStatus().then(
        (next) => { if (!cancelled) setStatus(next); },
        () => { if (!cancelled) setStatus(null); },
      );
    };
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, hasShared]);

  if (!hasShared || !status || status.servers.length === 0) return null;
  const summary = hubSummary(status);
  const using = hubProfiles(profiles);
  const muted = { color: "var(--app-text-tertiary)" };

  return (
    <section className="mb-3 rounded-lg border px-3 py-2.5" style={{ borderColor: "var(--app-border)" }} data-testid="mcp-hub-card">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Network size={14} aria-hidden="true" style={{ color: status.endpoint ? "var(--app-status-success)" : "var(--app-text-tertiary)" }} />
        <span className="text-[length:var(--text-row)] font-medium" style={{ color: "var(--app-text-primary)" }}>{t("mcpHubCard.title")}</span>
        <span className="font-mono text-[length:var(--text-micro)]" style={muted}>{t("mcpHubCard.badge")}</span>
        <span className="text-[length:var(--text-micro)]" style={{ color: "var(--app-text-secondary)" }} data-testid="mcp-hub-counts">
          {t("mcpHubCard.servers", { count: summary.servers })}
          {" · "}
          {summary.tools > 0 || !summary.toolsPending ? t("mcpHubCard.tools", { count: summary.tools }) : t("mcpHubCard.toolsPending")}
        </span>
      </div>
      <p className="mt-1 text-[length:var(--text-micro)]" style={muted}>{t("mcpHubCard.intro")}</p>
      <div className="mt-1 space-y-0.5 text-[length:var(--text-micro)]" style={muted}>
        <div className="font-mono" data-testid="mcp-hub-endpoint">
          {status.endpoint ? t("mcpHubCard.endpoint", { endpoint: status.endpoint }) : t("mcpHubCard.endpointDown")}
        </div>
        {summary.stopped.length > 0 && <div>{t("mcpHubCard.stopped", { names: summary.stopped.join(", ") })}</div>}
        {summary.direct.length > 0 && <div>{t("mcpHubCard.direct", { names: summary.direct.join(", ") })}</div>}
        <div data-testid="mcp-hub-profiles">
          {using.length > 0
            ? t("mcpHubCard.profiles", {
              names: using
                .map((item) => (hubFallsBackForProfile(item) ? t("mcpHubCard.fallsBack", { name: profileName(item) }) : profileName(item)))
                .join(", "),
            })
            : t("mcpHubCard.noProfiles")}
        </div>
      </div>
    </section>
  );
}

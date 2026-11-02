// 资源中心的 MCP tab：共享和内置 server 按启动档开关，本层 server 只读显示。
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ClipboardPaste, Loader2, Play, Server, Square } from "lucide-react";
import { toolLabel } from "@/components/providers/launchProfileHelpers";
import { commandLine } from "@/components/settings/mcpHubModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { toastErr } from "@/lib/feedback";
import { useLaunchProfilesStore } from "@/stores/useLaunchProfilesStore";
import { EMPTY_MCP_LAYER, useMcpStore } from "@/stores/useMcpStore";
import { useSharedMcpStore } from "@/stores/useSharedMcpStore";
import { mcpTargetKey, type LaunchProfile, type McpLayerTarget } from "@/types";
import { translateError } from "@/utils";
import PasteMcpDialog from "./PasteMcpDialog";
import ProfileChips, { type ProfileChipItem } from "./ProfileChips";
import {
  mcpChipState,
  mcpStatusOf,
  setMcpResource,
  type ChipBlockReason,
  type McpStatusLevel,
  type ProfileMcpResource,
} from "./resourceCenterModel";
import { useProfilePolicyWriter } from "./useProfilePolicyWriter";

interface McpResourceTabProps {
  profiles: readonly LaunchProfile[];
  layerTarget: McpLayerTarget | null;
  layerLabel: string | null;
}

const STATUS_COLOR: Record<McpStatusLevel, string> = {
  running: "var(--app-status-success)",
  starting: "var(--app-accent)",
  stopped: "var(--app-text-tertiary)",
  failed: "var(--app-status-danger)",
};

export default function McpResourceTab({ profiles, layerTarget, layerLabel }: McpResourceTabProps) {
  const { t } = useTranslation("settings");
  const { t: tProviders } = useTranslation("providers");
  const sharedServers = useSharedMcpStore((s) => s.servers);
  const fetchStatus = useSharedMcpStore((s) => s.fetchStatus);
  const startShared = useSharedMcpStore((s) => s.startServer);
  const stopShared = useSharedMcpStore((s) => s.stopServer);
  const loadLayer = useMcpStore((s) => s.loadServers);
  const layerServers = useMcpStore((s) => (layerTarget ? s.layers[mcpTargetKey(layerTarget)] ?? EMPTY_MCP_LAYER : EMPTY_MCP_LAYER).servers);
  const loadProfiles = useLaunchProfilesStore((s) => s.load);

  const [pasteOpen, setPasteOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ resource: string; text: string } | null>(null);

  const { overlay, apply } = useProfilePolicyWriter((error) => {
    toastErr(t("resourceCenter.saveFailed", { error: translateError(error) }));
    void loadProfiles();
  });

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);
  useEffect(() => {
    if (layerTarget) void loadLayer(layerTarget);
  }, [layerTarget, loadLayer]);

  const profileName = (profile: LaunchProfile) => profile.alias || profile.name;
  const chipsFor = (resource: ProfileMcpResource): ProfileChipItem[] =>
    profiles.map((profile) => ({
      profileId: profile.id,
      label: `${profileName(profile)}${profile.targetTools.length === 1 ? ` · ${toolLabel(profile.targetTools[0], tProviders)}` : ""}`,
      state: mcpChipState(overlay[profile.id]?.mcpPolicy ?? profile.mcpPolicy, resource),
    }));

  const handleChange = (key: string, resource: ProfileMcpResource) => (profileId: string, on: boolean) => {
    setNotice({ resource: key, text: t("resourceCenter.nextLaunch") });
    apply(profileId, (draft) => setMcpResource(draft, resource, on));
  };
  const handleBlocked = (key: string) => (reason: ChipBlockReason, profileId: string) => {
    const profile = profiles.find((item) => item.id === profileId);
    setNotice({ resource: key, text: t(`resourceCenter.blocked.${reason}`, { name: profile ? profileName(profile) : "" }) });
  };

  const runShared = async (name: string, running: boolean) => {
    setBusy(name);
    try {
      await (running ? stopShared(name) : startShared(name));
    } catch (error) {
      toastErr(t("resourceCenter.saveFailed", { error: translateError(error) }));
    } finally {
      setBusy(null);
    }
  };

  const layerEntries = useMemo(() => Object.entries(layerServers).sort(([a], [b]) => a.localeCompare(b)), [layerServers]);
  const sortedShared = useMemo(() => [...sharedServers].sort((a, b) => a.name.localeCompare(b.name)), [sharedServers]);
  const rowNotice = (key: string) =>
    notice?.resource === key ? (
      <p className="mt-1 text-[11px]" style={{ color: "var(--app-text-secondary)" }} role="status" data-testid="resource-row-notice">
        {notice.text}
      </p>
    ) : null;

  return (
    <div className="space-y-5" data-testid="resource-mcp-tab">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs leading-relaxed" style={{ color: "var(--app-text-tertiary)" }}>{t("resourceCenter.mcpIntro")}</p>
        <Button size="sm" className="h-8 shrink-0" onClick={() => setPasteOpen(true)} data-testid="mcp-paste-open">
          <ClipboardPaste size={13} className="mr-1.5" />
          {t("resourceCenter.paste.open")}
        </Button>
      </div>

      <section aria-label={t("resourceCenter.profileManaged")}>
        <h2 className="mb-2 text-xs font-medium" style={{ color: "var(--app-text-secondary)" }}>{t("resourceCenter.profileManaged")}</h2>
        {profiles.length === 0 && <p className="mb-2 text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("resourceCenter.noProfiles")}</p>}
        <div className="divide-y rounded-lg border" style={{ borderColor: "var(--app-home-border)" }}>
          <Row
            name="CC-Panes MCP"
            detail={tProviders("ccpanesMcpDesc")}
            chips={<ProfileChips resourceName="CC-Panes MCP" items={chipsFor({ kind: "ccpanes" })} onChange={handleChange("ccpanes", { kind: "ccpanes" })} onBlocked={handleBlocked("ccpanes")} />}
            notice={rowNotice("ccpanes")}
          />
          {sortedShared.map((server) => {
            const { level, reason } = mcpStatusOf(server.status);
            const key = `shared:${server.name}`;
            const resource: ProfileMcpResource = { kind: "shared", name: server.name };
            const running = level === "running";
            return (
              <Row
                key={server.name}
                name={server.name}
                status={<span style={{ color: STATUS_COLOR[level] }}>{t(`mcpStatus.${level}`)}</span>}
                source={t("mcpSourceShared")}
                detail={commandLine(server.config)}
                mono
                failure={reason}
                actions={
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={busy === server.name || level === "starting"} onClick={() => void runShared(server.name, running)}>
                    {busy === server.name ? <Loader2 size={13} className="animate-spin" /> : running ? <Square size={13} /> : <Play size={13} />}
                    <span className="ml-1">{running ? t("mcpStop") : t("mcpStart")}</span>
                  </Button>
                }
                chips={<ProfileChips resourceName={server.name} items={chipsFor(resource)} onChange={handleChange(key, resource)} onBlocked={handleBlocked(key)} />}
                notice={rowNotice(key)}
              />
            );
          })}
        </div>
        {sortedShared.length === 0 && (
          <div className="mt-3">
            <EmptyState
              icon={Server}
              title={t("resourceCenter.noShared")}
              description={t("resourceCenter.noSharedHint")}
              action={{ label: t("resourceCenter.paste.open"), onClick: () => setPasteOpen(true) }}
            />
          </div>
        )}
      </section>

      {layerTarget && (
        <section aria-label={t("resourceCenter.layerManaged")}>
          <h2 className="mb-1 text-xs font-medium" style={{ color: "var(--app-text-secondary)" }}>
            {t("resourceCenter.layerManaged")}
            {layerLabel ? ` · ${layerLabel}` : ""}
          </h2>
          <p className="mb-2 text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>{t("resourceCenter.layerHint")}</p>
          {layerEntries.length === 0 ? (
            <p className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("resourceCenter.layerEmpty")}</p>
          ) : (
            <div className="divide-y rounded-lg border" style={{ borderColor: "var(--app-home-border)" }}>
              {layerEntries.map(([name, config]) => (
                <Row
                  key={name}
                  name={name}
                  status={<span style={{ color: "var(--app-text-tertiary)" }}>{t("resourceCenter.startsWithSession")}</span>}
                  detail={config.url ?? commandLine(config)}
                  mono
                  chips={<Badge variant="outline" className="text-[10px]">{t("resourceCenter.notProfileControlled")}</Badge>}
                />
              ))}
            </div>
          )}
        </section>
      )}

      <PasteMcpDialog open={pasteOpen} onOpenChange={setPasteOpen} layerTarget={layerTarget} layerLabel={layerLabel} />
    </div>
  );
}

function Row({
  name,
  status,
  source,
  detail,
  mono,
  failure,
  actions,
  chips,
  notice,
}: {
  name: string;
  status?: React.ReactNode;
  source?: string;
  detail: string;
  mono?: boolean;
  failure?: string | null;
  actions?: React.ReactNode;
  chips: React.ReactNode;
  notice?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-2 px-3 py-2.5" data-testid="resource-row" data-resource-name={name}>
      <div className="min-w-48 flex-1">
        <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
          <span className="font-medium" style={{ color: "var(--app-text-primary)" }}>{name}</span>
          {status && <span className="text-[11px]">{status}</span>}
          {source && <span className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>· {source}</span>}
        </div>
        <p className={`mt-0.5 break-all text-[11px] ${mono ? "font-mono" : ""}`} style={{ color: "var(--app-text-tertiary)" }}>{detail}</p>
        {failure && <p className="mt-1 break-all font-mono text-[11px]" style={{ color: "var(--app-status-danger)" }} data-testid="resource-row-failure">{failure}</p>}
        {notice}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {actions}
        {chips}
      </div>
    </div>
  );
}

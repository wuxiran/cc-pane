// 单台设备：状态、CLI 安装情况、工作空间与运行中的会话。docs/111-multi-device.md
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  Loader2,
  Monitor,
  MoreHorizontal,
  Plus,
  Server,
  SquareTerminal,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDevicesStore } from "@/stores/useDevicesStore";
import { getErrorMessage } from "@/utils";
import type { DeviceSummary, DeviceWorkspace, DeviceWorkspaceProject } from "@/types/device";
import { openRemoteSession, startRemoteSession } from "./openRemoteSession";
import {
  deviceStatus,
  joinSessions,
  needsDeploy,
  shortVersion,
  versionMismatch,
  visibleCliTools,
  type DeviceStatus,
} from "./devicesModel";

const STATUS_COLOR: Record<DeviceStatus, string> = {
  unknown: "var(--app-text-tertiary)",
  online: "var(--app-status-success)",
  sshFailed: "var(--app-status-danger)",
  notRunning: "var(--app-status-warning)",
  unauthorized: "var(--app-status-warning)",
  error: "var(--app-status-danger)",
};

interface DeviceCardProps {
  device: DeviceSummary;
  localVersion: string | null;
  onRefresh: () => void;
  onDeploy: () => void;
  onUpdateToken: () => void;
  onRemove: () => void;
}

function SmallButton({ children, onClick, disabled }: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors hover:bg-[var(--app-hover)] disabled:opacity-50"
      style={{ borderColor: "var(--app-border)", color: "var(--app-text-primary)" }}
    >
      {children}
    </button>
  );
}

export default function DeviceCard({
  device,
  localVersion,
  onRefresh,
  onDeploy,
  onUpdateToken,
  onRemove,
}: DeviceCardProps) {
  const { t } = useTranslation("sidebar");
  const snapshot = useDevicesStore((s) => s.snapshots[device.id]);
  const progress = useDevicesStore((s) => s.deploying[device.id] ?? null);
  const [expanded, setExpanded] = useState(true);

  const status = deviceStatus(snapshot);
  const info = snapshot?.info ?? null;
  const isSsh = device.connection.kind === "ssh";
  const deployable = needsDeploy(device, status);
  const outdated = status === "online" && versionMismatch(info?.appVersion, localVersion);
  const cliTools = visibleCliTools(snapshot?.environment?.cliTools);
  const sessions = joinSessions(snapshot?.sessions, snapshot?.launches);
  const workspaces = snapshot?.workspaces ?? [];
  const DeviceIcon = info?.headless || isSsh ? Server : Monitor;
  const launchableClis = cliTools.filter((tool) => tool.installed);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
    try {
      await action();
    } catch (error) {
      toast.error(t("devices.openFailed", { error: getErrorMessage(error) }));
    } finally {
      setBusy(null);
    }
  };

  const projectName = (project: DeviceWorkspaceProject) =>
    project.alias || project.path.split("/").filter(Boolean).pop() || project.path;

  const newSession = (workspace: DeviceWorkspace, project: DeviceWorkspaceProject, cliTool: string) =>
    run(`new:${project.id}`, () => startRemoteSession(
      device,
      { path: project.path, name: projectName(project) },
      { name: workspace.name, path: workspace.path },
      cliTool,
    ));

  const hint = (() => {
    if (progress) return null;
    switch (status) {
      case "notRunning":
        return isSsh ? t("devices.hint.notRunning") : snapshot?.error;
      case "unauthorized":
        return isSsh ? t("devices.hint.unauthorized") : t("devices.hint.unauthorizedDirect");
      case "sshFailed":
      case "error":
        return snapshot?.error;
      default:
        return outdated
          ? t("devices.hint.versionMismatch", { remote: info?.appVersion, local: localVersion })
          : null;
    }
  })();

  return (
    <div
      className="rounded-lg px-2 py-1.5 transition-colors hover:bg-[var(--app-hover)]"
      data-testid={`device-card-${device.id}`}
    >
      <div className="flex min-w-0 items-start gap-2">
        <button
          type="button"
          aria-label={expanded ? "collapse" : "expand"}
          className="mt-0.5 flex h-5 w-4 shrink-0 items-center justify-center"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? <ChevronDown className="h-3 w-3" style={{ color: "var(--app-text-tertiary)" }} />
            : <ChevronRight className="h-3 w-3" style={{ color: "var(--app-text-tertiary)" }} />}
        </button>
        <div className="relative mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
          <DeviceIcon className="h-4 w-4" style={{ color: "var(--app-text-secondary)" }} />
          <span
            className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border"
            style={{ background: STATUS_COLOR[status], borderColor: "var(--app-sidebar-bg)" }}
            data-status={status}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[13px] font-medium" style={{ color: "var(--app-text-primary)" }}>
              {device.name}
            </span>
            {info?.appVersion && (
              <span className="shrink-0 text-[10px] tabular-nums" style={{ color: "var(--app-text-tertiary)" }}>
                v{info.appVersion}
              </span>
            )}
          </div>
          <span className="block truncate text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>
            {progress
              ? `${t(`devices.deployStep.${progress.step}`)}${progress.fraction != null ? ` ${Math.round(progress.fraction * 100)}%` : ""}`
              : status === "online" && info
                ? `${device.targetLabel} · ${info.osVersion ?? info.os} ${info.arch}`
                : `${device.targetLabel} · ${t(`devices.status.${status}`)}`}
          </span>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="device actions"
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-[var(--app-active)]"
            >
              <MoreHorizontal className="h-3.5 w-3.5" style={{ color: "var(--app-text-secondary)" }} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onRefresh}>{t("devices.refresh")}</DropdownMenuItem>
            {isSsh && (
              <DropdownMenuItem disabled={Boolean(progress)} onSelect={onDeploy}>
                {status === "online" ? t("devices.redeploy") : t("devices.deploy")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={onUpdateToken}>{t("devices.updateToken")}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onRemove} style={{ color: "var(--app-status-danger)" }}>
              {t("devices.remove")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {(hint || deployable || outdated || progress) && (
        <div className="ml-11 mt-1 flex flex-col items-start gap-1">
          {hint && (
            <p className="line-clamp-3 break-all text-[11px] leading-snug" style={{ color: "var(--app-text-secondary)" }}>
              {hint}
            </p>
          )}
          {progress ? (
            <span className="flex items-center gap-1 text-[11px]" style={{ color: "var(--app-text-secondary)" }}>
              <Loader2 className="h-3 w-3 animate-spin" />
              {t(`devices.deployStep.${progress.step}`)}
            </span>
          ) : isSsh && (deployable || outdated) ? (
            <SmallButton onClick={onDeploy}>
              {outdated && localVersion ? t("devices.upgrade", { version: localVersion }) : t("devices.deploy")}
            </SmallButton>
          ) : !isSsh && status === "unauthorized" ? (
            <SmallButton onClick={onUpdateToken}>{t("devices.updateToken")}</SmallButton>
          ) : null}
        </div>
      )}

      {expanded && status === "online" && (
        <div className="ml-11 mt-1.5 flex flex-col gap-2">
          {cliTools.length > 0 && (
            <div className="flex flex-wrap gap-1" data-testid="device-cli-tools">
              {cliTools.map((tool) => (
                <span
                  key={tool.id}
                  className="rounded-full px-1.5 py-0.5 text-[10px] leading-none"
                  style={tool.installed
                    ? { background: "var(--app-status-success-bg)", color: "var(--app-status-success)" }
                    : { background: "var(--app-hover)", color: "var(--app-text-tertiary)" }}
                  title={tool.version ?? undefined}
                >
                  {tool.id} {tool.installed ? shortVersion(tool.version) ?? "✓" : t("devices.cli.notInstalled")}
                </span>
              ))}
            </div>
          )}

          <div>
            <div className="mb-0.5 text-[10px] font-medium" style={{ color: "var(--app-text-tertiary)" }}>
              {t("devices.sessions")}
            </div>
            {sessions.length === 0 ? (
              <div className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>{t("devices.noSessions")}</div>
            ) : sessions.map((session) => (
              <button
                type="button"
                key={session.sessionId}
                title={t("devices.open")}
                disabled={busy !== null}
                onClick={() => void run(`open:${session.sessionId}`, () => openRemoteSession(device, session.sessionId, {
                  projectPath: session.projectPath ?? info?.homeDir ?? "~",
                  projectName: session.projectName,
                  cliTool: session.cliTool,
                }))}
                className="-mx-1 flex w-[calc(100%+0.5rem)] min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] transition-colors hover:bg-[var(--app-active)] disabled:opacity-60"
              >
                {busy === `open:${session.sessionId}`
                  ? <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                  : <SquareTerminal className="h-3 w-3 shrink-0" style={{ color: "var(--app-text-tertiary)" }} />}
                <span className="truncate" style={{ color: "var(--app-text-primary)" }}>
                  {session.projectName ?? t("devices.unknownProject")}
                </span>
                {session.cliTool && (
                  <span className="shrink-0" style={{ color: "var(--app-text-tertiary)" }}>{session.cliTool}</span>
                )}
                <span className="ml-auto shrink-0" style={{ color: "var(--app-text-tertiary)" }}>{session.status}</span>
              </button>
            ))}
          </div>

          <div>
            <div className="mb-0.5 text-[10px] font-medium" style={{ color: "var(--app-text-tertiary)" }}>
              {t("devices.workspaces")}
            </div>
            {workspaces.length === 0 ? (
              <div className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>{t("devices.noWorkspaces")}</div>
            ) : workspaces.map((workspace) => (
              <div key={workspace.id} className="py-0.5">
                <div className="truncate text-[11px] font-medium" style={{ color: "var(--app-text-primary)" }}>
                  {workspace.alias || workspace.name}
                </div>
                {workspace.projects.map((project) => (
                  <div key={project.id} className="group/project flex min-w-0 items-center gap-1.5 pl-2 text-[11px]" title={project.path}>
                    {busy === `new:${project.id}`
                      ? <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                      : <Folder className="h-3 w-3 shrink-0" style={{ color: "var(--app-text-tertiary)" }} />}
                    <span className="truncate" style={{ color: "var(--app-text-secondary)" }}>
                      {projectName(project)}
                    </span>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label={t("devices.newSession")}
                          title={t("devices.newSession")}
                          disabled={busy !== null}
                          className="ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-[var(--app-active)] focus:opacity-100 group-hover/project:opacity-100"
                        >
                          <Plus className="h-3 w-3" style={{ color: "var(--app-text-secondary)" }} />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {launchableClis.map((tool) => (
                          <DropdownMenuItem key={tool.id} onSelect={() => void newSession(workspace, project, tool.id)}>
                            {tool.displayName ?? tool.id}
                          </DropdownMenuItem>
                        ))}
                        {launchableClis.length > 0 && <DropdownMenuSeparator />}
                        <DropdownMenuItem onSelect={() => void newSession(workspace, project, "none")}>
                          {t("devices.shell")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

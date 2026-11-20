import { memo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Copy,
  CloudUpload,
  FolderOpen,
  KeyRound,
  Link2,
  LockKeyhole,
  Monitor,
  MoreHorizontal,
  Pencil,
  Radio,
  RefreshCw,
  Server,
  Star,
  Terminal,
  Trash2,
  Wifi,
  WifiOff,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { SshCcPanesProbe, SshMachine } from "@/types";
import {
  sidebarEntityActionsClass,
  sidebarEntityBadgeClass,
  sidebarEntityContentClass,
  sidebarEntityIconSlotClass,
  sidebarEntityMetaClass,
  sidebarEntityRowClass,
  sidebarEntityTitleClass,
} from "./sidebarStyles";
import { detectedCcPanes, osLabelKey, type ConnectivityState } from "./sshMachineProbe";

export type { ConnectivityState } from "./sshMachineProbe";

function StatusDot({ state }: { state: ConnectivityState }) {
  const { t } = useTranslation("sidebar");
  let color = "var(--app-text-muted)";
  let label = t("ssh.statusUnknown", { defaultValue: "Not checked" });
  if (state === "checking") {
    color = "var(--app-status-warning)";
    label = t("ssh.statusChecking", { defaultValue: "Checking" });
  } else if (state?.reachable) {
    color = "var(--app-status-success)";
    label = t("ssh.statusOnline", { defaultValue: "Online" });
  } else if (state) {
    color = "var(--app-status-danger)";
    label = state.message || t("ssh.statusOffline", { defaultValue: "Unavailable" });
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="status"
          aria-label={label}
          className={`block h-2 w-2 rounded-full border border-[var(--app-sidebar-bg)] ${state === "checking" ? "animate-pulse" : ""}`}
          style={{ background: color }}
        />
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

interface MachineItemProps {
  machine: SshMachine;
  connectivity: ConnectivityState;
  favorite: boolean;
  selected: boolean;
  onSelect: (machine: SshMachine) => void;
  onConnect: (machine: SshMachine) => void;
  onOpenFiles: (machine: SshMachine) => void;
  onEdit: (machine: SshMachine) => void;
  onDelete: (machine: SshMachine) => void;
  onCopy: (machine: SshMachine) => void;
  onCheckConnectivity: (machineId: string) => void;
  onToggleFavorite: (machineId: string) => void;
  /** 合并视图：这台主机还没有部署 CC-Panes 时，菜单里提供「部署 CC-Panes」 */
  onDeployCcPanes?: (machine: SshMachine) => void;
  /** 合并视图：探测到这台主机上在跑 CC-Panes 且尚未添加时，菜单里提供「连接」 */
  onConnectCcPanes?: (machine: SshMachine, ccPanes: SshCcPanesProbe) => void;
  /** 合并视图：挂在这台主机上的 CC-Panes（渲染在行下方，不在可点击行内） */
  children?: ReactNode;
}

function formatConnection(machine: SshMachine): string {
  const userPart = machine.user ? `${machine.user}@` : "";
  return machine.port === 22
    ? `${userPart}${machine.host}`
    : `${userPart}${machine.host}:${machine.port}`;
}

function MachineMenuItems({
  machine,
  favorite,
  onConnect,
  onOpenFiles,
  onEdit,
  onDelete,
  onCopy,
  onCheckConnectivity,
  onToggleFavorite,
  onDeployCcPanes,
  onConnectCcPanes,
  ccPanes,
  dropdown = false,
}: Omit<MachineItemProps, "connectivity" | "selected" | "onSelect" | "children"> & {
  ccPanes: SshCcPanesProbe | null;
  dropdown?: boolean;
}) {
  const { t } = useTranslation("sidebar");
  const Item = dropdown ? DropdownMenuItem : ContextMenuItem;
  return (
    <>
      <Item onClick={() => onConnect(machine)}>
        <Terminal className="mr-2 h-3.5 w-3.5" />
        {t("ssh.connect", { defaultValue: "Connect" })}
      </Item>
      <Item onClick={() => onOpenFiles(machine)}>
        <FolderOpen className="mr-2 h-3.5 w-3.5" />
        {t("ssh.openFiles", { defaultValue: "Remote Files" })}
      </Item>
      {onDeployCcPanes && (
        <Item onClick={() => onDeployCcPanes(machine)}>
          <CloudUpload className="mr-2 h-3.5 w-3.5" />
          {t("machines.deployCcPanes")}
        </Item>
      )}
      {onConnectCcPanes && ccPanes && (
        <Item
          disabled={!ccPanes.pairingSupported}
          data-testid="machine-connect-ccpanes"
          onClick={() => onConnectCcPanes(machine, ccPanes)}
        >
          <Link2 className="mr-2 h-3.5 w-3.5 shrink-0" />
          <span className="flex min-w-0 flex-col">
            <span>{t("machines.connectCcPanes")}</span>
            {!ccPanes.pairingSupported && (
              <span className="text-[length:var(--text-micro)] text-[var(--app-text-tertiary)]">
                {t("machines.ccPanesUpgradeHint")}
              </span>
            )}
          </span>
        </Item>
      )}
      <Item onClick={() => onToggleFavorite(machine.id)}>
        <Star className="mr-2 h-3.5 w-3.5" fill={favorite ? "currentColor" : "none"} />
        {t(favorite ? "ssh.unfavorite" : "ssh.favorite", {
          defaultValue: favorite ? "Remove from Favorites" : "Add to Favorites",
        })}
      </Item>
      <Item onClick={() => onCheckConnectivity(machine.id)}>
        <RefreshCw className="mr-2 h-3.5 w-3.5" />
        {t("ssh.checkConnectivity", { defaultValue: "Check Connectivity" })}
      </Item>
      <Item onClick={() => onEdit(machine)}>
        <Pencil className="mr-2 h-3.5 w-3.5" />
        {t("ssh.edit", { defaultValue: "Edit" })}
      </Item>
      <Item onClick={() => onCopy(machine)}>
        <Copy className="mr-2 h-3.5 w-3.5" />
        {t("ssh.copyConnection", { defaultValue: "Copy Connection" })}
      </Item>
      <Item
        onClick={() => onDelete(machine)}
        className="text-[var(--app-status-danger)] focus:text-[var(--app-status-danger)]"
      >
        <Trash2 className="mr-2 h-3.5 w-3.5" />
        {t("ssh.delete", { defaultValue: "Delete" })}
      </Item>
    </>
  );
}

function ActionButton({
  label,
  onClick,
  children,
  className = "",
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--app-hover)] ${className}`}
          onClick={(event) => {
            event.stopPropagation();
            onClick();
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

const MachineItem = memo(function MachineItem(props: MachineItemProps) {
  const { t } = useTranslation("sidebar");
  const { machine, connectivity, favorite, selected } = props;
  const authLabel = t(
    machine.authMethod === "password"
      ? "ssh.authPassword"
      : machine.authMethod === "agent"
        ? "ssh.authAgent"
        : "ssh.authKey",
  );
  const AuthIcon = machine.authMethod === "password" ? LockKeyhole : KeyRound;
  const status = connectivity === "checking"
    ? { label: t("ssh.statusChecking", { defaultValue: "Checking" }), icon: Radio }
    : connectivity?.reachable
      ? { label: t("ssh.statusOnline", { defaultValue: "Online" }), icon: Wifi }
      : connectivity
        ? { label: t("ssh.statusOffline", { defaultValue: "Unavailable" }), icon: WifiOff }
        : { label: t("ssh.statusUnknown", { defaultValue: "Not checked" }), icon: Radio };
  const StatusIcon = status.icon;
  const osKey = osLabelKey(connectivity);
  const ccPanes = detectedCcPanes(connectivity);
  const menuProps = {
    machine,
    favorite,
    onConnect: props.onConnect,
    onOpenFiles: props.onOpenFiles,
    onEdit: props.onEdit,
    onDelete: props.onDelete,
    onCopy: props.onCopy,
    onCheckConnectivity: props.onCheckConnectivity,
    onToggleFavorite: props.onToggleFavorite,
    onDeployCcPanes: props.onDeployCcPanes,
    onConnectCcPanes: props.onConnectCcPanes,
    ccPanes,
  };

  return (
    <div className="flex flex-col" data-testid={`machine-entry-${machine.id}`}>
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          className={`${sidebarEntityRowClass} cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] ${
            selected
              ? "bg-[var(--app-active-bg)] text-[var(--app-accent)]"
              : "hover:bg-[var(--app-hover)]"
          }`}
          aria-selected={selected}
          onClick={() => props.onSelect(machine)}
          onDoubleClick={() => props.onConnect(machine)}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              props.onSelect(machine);
            }
          }}
        >
          <div className={sidebarEntityContentClass}>
            <div className={sidebarEntityIconSlotClass}>
              <Server className="h-4 w-4 text-[var(--app-text-muted)]" />
              <span className="absolute -bottom-0.5 -right-0.5">
                <StatusDot state={connectivity} />
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1">
                <span className={sidebarEntityTitleClass}>
                  {machine.name}
                </span>
                {ccPanes && (
                  <span
                    data-testid={`machine-ccpanes-badge-${machine.id}`}
                    className={`${sidebarEntityBadgeClass} bg-[color-mix(in_srgb,var(--app-status-success)_14%,transparent)] text-[var(--app-status-success)]`}
                  >
                    {t("machines.ccPanesRunning")}
                  </span>
                )}
                {machine.tags.map((tag) => (
                  <span
                    key={tag}
                    className={`${sidebarEntityBadgeClass} hidden bg-[color-mix(in_srgb,var(--app-text-primary)_8%,transparent)] text-[var(--app-text-secondary)] @min-[360px]/sidebar:inline-flex`}
                  >
                    {tag}
                  </span>
                ))}
              </div>
              <span className={sidebarEntityMetaClass}>
                {formatConnection(machine)}
              </span>
              {machine.description && (
                <span className={sidebarEntityMetaClass}>
                  {machine.description}
                </span>
              )}
            </div>
            <div className={sidebarEntityActionsClass}>
              <ActionButton
                label={t("ssh.openFilesForMachine", {
                  defaultValue: "Open remote files for {{name}}",
                  name: machine.name,
                })}
                onClick={() => props.onOpenFiles(machine)}
                className="hidden @min-[280px]/sidebar:flex"
              >
                <FolderOpen className="h-3.5 w-3.5 text-[var(--app-text-secondary)]" />
              </ActionButton>
              <ActionButton
                label={t("ssh.connectMachine", {
                  defaultValue: "Connect to {{name}}",
                  name: machine.name,
                })}
                onClick={() => props.onConnect(machine)}
                className="hidden @min-[280px]/sidebar:flex"
              >
                <Terminal className="h-3.5 w-3.5 text-[var(--app-text-secondary)]" />
              </ActionButton>
              <ActionButton
                label={t("ssh.checkConnectivity", { defaultValue: "Check Connectivity" })}
                onClick={() => props.onCheckConnectivity(machine.id)}
                className="hidden @min-[360px]/sidebar:flex"
              >
                <RefreshCw className={`h-3.5 w-3.5 text-[var(--app-text-secondary)] ${connectivity === "checking" ? "animate-spin" : ""}`} />
              </ActionButton>
              <ActionButton
                label={t(favorite ? "ssh.unfavorite" : "ssh.favorite", {
                  defaultValue: favorite ? "Remove from Favorites" : "Add to Favorites",
                })}
                onClick={() => props.onToggleFavorite(machine.id)}
                className="hidden @min-[360px]/sidebar:flex"
              >
                <Star
                  className="h-3.5 w-3.5"
                  fill={favorite ? "currentColor" : "none"}
                  style={{ color: favorite ? "var(--app-accent)" : "var(--app-text-secondary)" }}
                />
              </ActionButton>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("ssh.moreActions", { defaultValue: "More actions" })}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--app-hover)] focus-visible:bg-[var(--app-hover)]"
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    <MoreHorizontal className="h-3.5 w-3.5 text-[var(--app-text-secondary)]" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[140px]">
                  <MachineMenuItems {...menuProps} dropdown />
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          <div className={`${sidebarEntityMetaClass} ml-7 mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5`}>
            <span className="inline-flex shrink-0 items-center gap-1">
              <AuthIcon className="h-3 w-3" />
              {authLabel}
            </span>
            <span className="inline-flex shrink-0 items-center gap-1">
              <StatusIcon className="h-3 w-3" />
              {status.label}
            </span>
            {osKey && (
              <span className="inline-flex shrink-0 items-center gap-1" data-testid={`machine-os-${machine.id}`}>
                <Monitor className="h-3 w-3" />
                {t(osKey)}
              </span>
            )}
            {machine.defaultPath && (
              <span className="inline-flex min-w-0 items-center gap-1 truncate">
                <FolderOpen className="h-3 w-3 shrink-0" />
                {machine.defaultPath}
              </span>
            )}
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-[140px]">
        <MachineMenuItems {...menuProps} />
      </ContextMenuContent>
    </ContextMenu>
    {props.children && <div className="ml-5 mt-0.5 flex flex-col gap-1">{props.children}</div>}
    </div>
  );
});

export default MachineItem;

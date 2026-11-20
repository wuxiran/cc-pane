import { MonitorSmartphone, Plus, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  sidebarSectionCountClass,
  sidebarSectionHeaderClass,
  sidebarSectionTitleClass,
} from "./sidebarStyles";

export interface HeaderAddOption {
  id: string;
  label: string;
  onSelect: () => void;
}

interface SshMachinesHeaderProps {
  /** 合并「设备」视图时覆盖标题；缺省为「SSH 机器」 */
  title?: string;
  /** 标题计数与「全部检测」按钮都按这个数（缺省 = 机器数） */
  totalCount?: number;
  /** 提供时「+」变成下拉菜单，先选要添加的类型 */
  addOptions?: readonly HeaderAddOption[];
  machineCount: number;
  checkingAll: boolean;
  showWslDiscovery: boolean;
  onCheckAll: () => void;
  onDiscoverWsl: () => void;
  onAdd: () => void;
}

export default function SshMachinesHeader({
  title,
  totalCount,
  addOptions,
  machineCount,
  checkingAll,
  showWslDiscovery,
  onCheckAll,
  onDiscoverWsl,
  onAdd,
}: SshMachinesHeaderProps) {
  const { t } = useTranslation("sidebar");
  const count = totalCount ?? machineCount;
  const addLabel = addOptions
    ? t("machines.add")
    : t("ssh.addMachine", { defaultValue: "Add SSH Machine" });
  const addButton = (
    <button
      type="button"
      aria-label={addLabel}
      className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--app-hover)]"
      onClick={addOptions ? undefined : onAdd}
    >
      <Plus
        className="h-3.5 w-3.5"
        style={{ color: "var(--app-text-secondary)" }}
      />
    </button>
  );
  return (
    <div className={sidebarSectionHeaderClass}>
      <div className="flex items-center gap-2">
        <span className={sidebarSectionTitleClass}>
          {title ?? t("sshMachines", { defaultValue: "SSH MACHINES" })}
        </span>
        <span
          className={sidebarSectionCountClass}
          style={{ background: "color-mix(in srgb, var(--app-text-primary) 8%, transparent)" }}
        >
          {count}
        </span>
      </div>
      <div className="flex items-center gap-0.5">
        {count > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t("ssh.checkAll", { defaultValue: "Check All Connectivity" })}
                className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--app-hover)] disabled:opacity-40"
                onClick={onCheckAll}
                disabled={checkingAll}
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${checkingAll ? "animate-spin" : ""}`}
                  style={{ color: "var(--app-text-secondary)" }}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t("ssh.checkAll", { defaultValue: "Check All Connectivity" })}
            </TooltipContent>
          </Tooltip>
        )}
        {showWslDiscovery && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t("ssh.wsl.discover", { defaultValue: "Discover WSL" })}
                className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--app-hover)]"
                onClick={onDiscoverWsl}
              >
                <MonitorSmartphone
                  className="h-3.5 w-3.5"
                  style={{ color: "var(--app-text-secondary)" }}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t("ssh.wsl.discover", { defaultValue: "Discover WSL" })}
            </TooltipContent>
          </Tooltip>
        )}
        {addOptions ? (
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>{addButton}</DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">{addLabel}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="min-w-[200px]">
              {addOptions.map((option) => (
                <DropdownMenuItem
                  key={option.id}
                  data-testid={`machines-add-${option.id}`}
                  onSelect={option.onSelect}
                >
                  {option.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>{addButton}</TooltipTrigger>
            <TooltipContent side="bottom">{addLabel}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

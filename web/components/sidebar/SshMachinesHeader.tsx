import { MonitorSmartphone, Plus, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  sidebarSectionCountClass,
  sidebarSectionHeaderClass,
  sidebarSectionTitleClass,
} from "./sidebarStyles";

interface SshMachinesHeaderProps {
  machineCount: number;
  checkingAll: boolean;
  showWslDiscovery: boolean;
  onCheckAll: () => void;
  onDiscoverWsl: () => void;
  onAdd: () => void;
}

export default function SshMachinesHeader({
  machineCount,
  checkingAll,
  showWslDiscovery,
  onCheckAll,
  onDiscoverWsl,
  onAdd,
}: SshMachinesHeaderProps) {
  const { t } = useTranslation("sidebar");
  return (
    <div className={sidebarSectionHeaderClass}>
      <div className="flex items-center gap-2">
        <span className={sidebarSectionTitleClass}>
          {t("sshMachines", { defaultValue: "SSH MACHINES" })}
        </span>
        <span
          className={sidebarSectionCountClass}
          style={{ background: "color-mix(in srgb, var(--app-text-primary) 8%, transparent)" }}
        >
          {machineCount}
        </span>
      </div>
      <div className="flex items-center gap-0.5">
        {machineCount > 0 && (
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
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t("ssh.addMachine", { defaultValue: "Add SSH Machine" })}
              className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--app-hover)]"
              onClick={onAdd}
            >
              <Plus
                className="h-3.5 w-3.5"
                style={{ color: "var(--app-text-secondary)" }}
              />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t("ssh.addMachine", { defaultValue: "Add SSH Machine" })}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

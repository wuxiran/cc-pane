import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Loader2, Star, Check } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSshMachinesStore } from "@/stores";
import { discoverWslDistros } from "@/services/sshMachineService";
import { getErrorMessage } from "@/utils";
import type { WslDistro, SshMachine } from "@/types";

interface WslDiscoverDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 状态徽章颜色映射 */
function stateBadgeVariant(state: WslDistro["state"]) {
  switch (state) {
    case "running":
      return "bg-green-500/15 text-green-600 dark:text-green-400";
    case "stopped":
      return "bg-gray-500/15 text-gray-600 dark:text-gray-400";
    case "installing":
      return "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400";
    default:
      return "bg-gray-500/15 text-gray-500";
  }
}

/** 状态文本 i18n 映射 */
const STATE_LABEL_KEYS: Record<WslDistro["state"], string> = {
  running: "ssh.wsl.stateRunning",
  stopped: "ssh.wsl.stateStopped",
  installing: "ssh.wsl.stateInstalling",
  unknown: "ssh.wsl.stateUnknown",
};

export default function WslDiscoverDialog({ open, onOpenChange }: WslDiscoverDialogProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const addMachine = useSshMachinesStore((s) => s.add);

  const [loading, setLoading] = useState(false);
  const [distros, setDistros] = useState<WslDistro[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 打开时自动发现（带竞态取消）
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    setDistros([]);
    setSelected(new Set());
    setError(null);
    setLoading(true);

    discoverWslDistros()
      .then((result) => {
        if (cancelled) return;
        setDistros(result);
        // 自动选中未导入且非 installing 的分发版
        const autoSelect = new Set(
          result
            .filter((d) => !d.alreadyImported && d.state !== "installing")
            .map((d) => d.name)
        );
        setSelected(autoSelect);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(getErrorMessage(e));
        setDistros([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [open]);

  const toggleSelect = useCallback((name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }, []);

  const handleImport = useCallback(async () => {
    const toImport = distros.filter(
      (d) => selected.has(d.name) && !d.alreadyImported
    );
    if (toImport.length === 0) return;

    setImporting(true);
    try {
      let successCount = 0;

      for (const distro of toImport) {
        const now = new Date().toISOString();
        const machine: SshMachine = {
          id: crypto.randomUUID(),
          name: `WSL: ${distro.name}`,
          host: "localhost",
          port: 22,
          user: distro.defaultUser ?? undefined,
          authMethod: "password",
          tags: ["wsl"],
          createdAt: now,
          updatedAt: now,
        };

        try {
          await addMachine(machine);
          successCount++;
        } catch (e) {
          toast.error(
            t("ssh.wsl.importFailed", {
              defaultValue: "Failed to import {{name}}: {{error}}",
              name: distro.name,
              error: getErrorMessage(e),
            })
          );
        }
      }

      if (successCount > 0) {
        toast.success(
          t("ssh.wsl.imported", {
            defaultValue: "{{count}} WSL distro(s) imported",
            count: successCount,
          })
        );
      }

      onOpenChange(false);
    } finally {
      setImporting(false);
    }
  }, [distros, selected, addMachine, onOpenChange, t]);

  const selectableCount = distros.filter(
    (d) => !d.alreadyImported && selected.has(d.name)
  ).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            {t("ssh.wsl.discoverTitle", { defaultValue: "Discover WSL Distros" })}
          </DialogTitle>
        </DialogHeader>

        <div className="py-2">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8">
              <Loader2 className="w-5 h-5 animate-spin" style={{ color: "var(--app-text-muted)" }} />
              <span className="text-sm" style={{ color: "var(--app-text-muted)" }}>
                {t("ssh.wsl.discovering", { defaultValue: "Scanning for WSL distributions..." })}
              </span>
            </div>
          ) : error ? (
            <div className="text-center py-8">
              <p className="text-sm text-red-500">{error}</p>
            </div>
          ) : distros.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-sm" style={{ color: "var(--app-text-muted)" }}>
                {t("ssh.wsl.noDistros", { defaultValue: "No WSL distributions found" })}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-1 max-h-[300px] overflow-y-auto">
              {distros.map((distro) => {
                const disabled = distro.alreadyImported;
                const checked = selected.has(distro.name) && !disabled;

                return (
                  <label
                    key={distro.name}
                    className={`flex items-center gap-3 px-3 py-2 rounded cursor-pointer transition-colors
                      ${disabled ? "opacity-50 cursor-not-allowed" : "hover:bg-[var(--app-hover)]"}
                      ${checked ? "bg-[var(--app-hover)]" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => !disabled && toggleSelect(distro.name)}
                      className="h-4 w-4 rounded border-gray-300 accent-[var(--app-accent)] cursor-pointer disabled:cursor-not-allowed"
                    />

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium truncate" style={{ color: "var(--app-text-primary)" }}>
                          {distro.name}
                        </span>
                        {distro.isDefault && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Star className="w-3 h-3 shrink-0 fill-yellow-400 text-yellow-400" />
                            </TooltipTrigger>
                            <TooltipContent side="right">
                              <p>{t("ssh.wsl.defaultDistro", { defaultValue: "Default distro" })}</p>
                            </TooltipContent>
                          </Tooltip>
                        )}
                        {distro.alreadyImported && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Check className="w-3.5 h-3.5 shrink-0 text-green-500" />
                            </TooltipTrigger>
                            <TooltipContent side="right">
                              <p>{t("ssh.wsl.alreadyImported", { defaultValue: "Already imported" })}</p>
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <Badge
                          variant="secondary"
                          className={`text-[10px] px-1.5 py-0 h-4 leading-none ${stateBadgeVariant(distro.state)}`}
                        >
                          {t(STATE_LABEL_KEYS[distro.state], { defaultValue: distro.state })}
                        </Badge>
                        <span className="text-[10px]" style={{ color: "var(--app-text-muted)" }}>
                          WSL{distro.wslVersion}
                        </span>
                        {distro.defaultUser && (
                          <span className="text-[10px]" style={{ color: "var(--app-text-muted)" }}>
                            {distro.defaultUser}@localhost
                          </span>
                        )}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          )}

          {/* 底部提示：非加载、非错误状态时显示 */}
          {!loading && !error && (
            <p className="text-[11px] mt-3 px-1" style={{ color: "var(--app-text-muted)" }}>
              {t("ssh.wsl.sshdHint", {
                defaultValue: "Tip: WSL distros need an SSH server (sshd) running to connect.",
              })}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common:cancel", { defaultValue: "Cancel" })}
          </Button>
          <Button
            onClick={handleImport}
            disabled={loading || importing || selectableCount === 0}
          >
            {importing ? (
              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
            ) : null}
            {t("ssh.wsl.import", {
              defaultValue: "Import ({{count}})",
              count: selectableCount,
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

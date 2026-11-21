// 「安装其他 Agent」里的一张卡（参考 magpie）：左侧图标+名称，右侧每种安装方式一行：
// 命令 + 复制 + 「安装」（在应用内终端里直接跑）。本机缺对应包管理器的方式排到后面、置灰并注明。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, ExternalLink, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import CliBrandIcon from "@/components/CliBrandIcon";
import { cn } from "@/lib/utils";
import { handleErrorSilent } from "@/utils/errorHandler";
import {
  OFFICIAL_SCRIPT_LABEL,
  isMethodAvailable,
  type AgentCatalogEntry,
  type InstallMethod,
  type PackageManagerAvailability,
} from "./agentCatalog";

interface HomeAgentInstallRowProps {
  entry: AgentCatalogEntry;
  methods: readonly InstallMethod[];
  available: PackageManagerAvailability;
  /** 在应用内新终端里执行命令；没有可用目录时为 undefined（只剩复制）。 */
  onRun?: (command: string) => void;
  onOpenHomepage: (url: string) => void;
}

function CopyCommandButton({ command }: { command: string }) {
  const { t } = useTranslation("home");
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <IconTooltipButton
      label={copied ? t("install.copied") : t("install.copy")}
      className="size-7 shrink-0"
      onClick={() => {
        navigator.clipboard
          ?.writeText(command)
          .then(() => {
            setCopied(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1500);
          })
          .catch((error) => handleErrorSilent(error, "copy install command"));
      }}
    >
      {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
    </IconTooltipButton>
  );
}

export function RunCommandButton({ onRun, disabled, title }: { onRun: () => void; disabled?: boolean; title?: string }) {
  const { t } = useTranslation("home");
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 shrink-0 gap-1.5 px-2"
      disabled={disabled}
      title={title}
      data-testid="home-agent-install-run"
      onClick={onRun}
    >
      <Play className="size-3.5" aria-hidden="true" />
      {t("install.run")}
    </Button>
  );
}

export default function HomeAgentInstallRow({ entry, methods, available, onRun, onOpenHomepage }: HomeAgentInstallRowProps) {
  const { t } = useTranslation("home");

  return (
    <li
      data-testid="home-agent-install-row"
      data-agent-id={entry.id}
      className="flex flex-col gap-3 rounded-2xl border border-[var(--app-home-border)] bg-[var(--app-home-surface)] px-5 py-4 md:flex-row md:items-start md:gap-6"
    >
      <div className="flex w-48 shrink-0 items-center gap-3 md:pt-1">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--app-hover)] text-[var(--app-text-primary)]">
          <CliBrandIcon cliTool={entry.id} className="size-4" />
        </span>
        <span className="truncate text-[length:var(--text-body)] font-medium text-[var(--app-text-primary)]">{entry.name}</span>
      </div>

      <div className="min-w-0 flex-1 space-y-2">
        {methods.map((method) => {
          const usable = isMethodAvailable(method, available);
          const missingTool = method.requires ? t("install.toolMissing", { tool: method.requires }) : undefined;
          return (
            <div key={method.command} data-available={usable} className="flex min-w-0 items-center gap-3">
              <span className="w-20 shrink-0 text-[length:var(--text-small)] text-[var(--app-text-tertiary)]">
                {method.label === OFFICIAL_SCRIPT_LABEL ? t("install.script") : method.label}
              </span>
              <code
                data-testid="home-agent-install-command"
                className={cn(
                  "min-w-0 flex-1 truncate rounded-md bg-[var(--app-hover)] px-3 py-1.5 font-mono text-[length:var(--text-small)] text-[var(--app-text-primary)]",
                  !usable && "opacity-50",
                )}
                title={method.command}
              >
                {method.command}
              </code>
              <CopyCommandButton command={method.command} />
              {onRun && (
                <RunCommandButton
                  onRun={() => onRun(method.command)}
                  disabled={!usable}
                  title={usable ? t("install.runTitle") : missingTool}
                />
              )}
            </div>
          );
        })}
      </div>

      <div className="flex shrink-0 items-center gap-1 md:pt-0.5">
        <IconTooltipButton label={t("install.homepage")} className="size-7" onClick={() => onOpenHomepage(entry.homepage)}>
          <ExternalLink className="size-3.5" aria-hidden="true" />
        </IconTooltipButton>
      </div>
    </li>
  );
}

// 环境预检：只把「要你动手的」摆在明面上。
//   基础依赖（Node / Git / WSL）一行小标签；缺项才带复制命令。
//   CLI：已装的列成标签；一个都没装时直接给 Claude Code / Codex 的安装命令；
//   其余未装的 CLI 折叠进「安装其他 CLI」，不再一行一张红叉卡片。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, ChevronRight, Copy, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { EnvironmentInfo } from "@/types";
import { primaryInstallCommand } from "@/components/home/agentCatalog";

interface EnvironmentPreflightCardProps {
  environment: EnvironmentInfo | null;
  checking: boolean;
  error: string | null;
}

interface ProbeItem {
  id: string;
  label: string;
  installed: boolean;
  version: string | null;
  repairCommand?: string;
}

const RECOMMENDED_CLIS = ["claude", "codex"];

function repairCommand(id: string): string | undefined {
  // Agent CLI 的安装命令与首页「安装其他 Agent」共用一份清单，避免两处漂移。
  const agentCommand = primaryInstallCommand(id);
  if (agentCommand) return agentCommand;
  const windows = typeof navigator !== "undefined" && /Win/i.test(navigator.platform);
  const commands: Record<string, string> = windows
    ? {
        node: "winget install OpenJS.NodeJS.LTS",
        git: "winget install --id Git.Git -e",
        wsl: "wsl --install",
      }
    : {
        node: "nvm install --lts",
        git: "sudo apt install git",
      };
  return commands[id];
}

function baseProbes(environment: EnvironmentInfo): ProbeItem[] {
  const items: ProbeItem[] = [
    { id: "node", label: "Node.js", installed: environment.node.installed, version: environment.node.version },
    { id: "git", label: "Git", installed: environment.git?.installed ?? false, version: environment.git?.version ?? null },
  ];
  // WSL 只在适用平台出现
  if (environment.wsl?.applicable) {
    items.push({ id: "wsl", label: "WSL", installed: environment.wsl.installed, version: environment.wsl.version });
  }
  return items.map((item) => ({ ...item, repairCommand: repairCommand(item.id) }));
}

function cliProbes(environment: EnvironmentInfo): ProbeItem[] {
  return environment.cliTools.map((tool) => ({
    id: tool.id,
    label: tool.displayName,
    installed: tool.installed,
    version: tool.version,
    repairCommand: repairCommand(tool.id),
  }));
}

export default function EnvironmentPreflightCard({
  environment,
  checking,
  error,
}: EnvironmentPreflightCardProps) {
  const { t } = useTranslation("onboarding");
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  if (checking) {
    return (
      <div className="flex min-h-24 items-center justify-center gap-2 text-sm text-[var(--app-text-secondary)]">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {t("environment.checking")}
      </div>
    );
  }
  if (error) return <p className="text-sm text-[var(--app-status-danger)]">{error}</p>;
  if (!environment) return null;

  const copy = async (probe: ProbeItem) => {
    if (!probe.repairCommand || !navigator.clipboard) {
      setCopyError(true);
      return;
    }
    try {
      await navigator.clipboard.writeText(probe.repairCommand);
      setCopied(probe.id);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  };

  const base = baseProbes(environment);
  const clis = cliProbes(environment);
  const installedClis = clis.filter((p) => p.installed);
  const missingClis = clis.filter((p) => !p.installed && p.repairCommand);
  // 一个 CLI 都没有：推荐项直接摊开，其余仍折叠
  const promoted = installedClis.length === 0
    ? missingClis.filter((p) => RECOMMENDED_CLIS.includes(p.id))
    : [];
  const folded = missingClis.filter((p) => !promoted.includes(p));
  const missingBase = base.filter((p) => !p.installed);

  const copyButton = (probe: ProbeItem) => (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 shrink-0 gap-1.5 px-2 text-xs"
      aria-label={t("environment.copyRepair", { name: probe.label })}
      onClick={() => void copy(probe)}
    >
      <Copy className="size-3.5" aria-hidden="true" />
      {copied === probe.id ? t("environment.copied") : t("environment.copy")}
    </Button>
  );

  const missingRow = (probe: ProbeItem) => (
    <div key={probe.id} className="flex items-center gap-2 py-1">
      <span className="min-w-0 flex-1 truncate text-[length:var(--text-row)] text-[var(--app-text-primary)]">
        {probe.label}
      </span>
      {probe.repairCommand && copyButton(probe)}
    </div>
  );

  return (
    <div className="space-y-4">
      {/* 基础依赖 */}
      <section className="space-y-1.5">
        <h4 className="text-[length:var(--text-caption)] font-medium text-[var(--app-text-tertiary)]">
          {t("environment.baseTitle")}
        </h4>
        <div className="flex flex-wrap gap-1.5">
          {base.map((probe) => (
            <Chip key={probe.id} probe={probe} />
          ))}
        </div>
        {missingBase.length > 0 && <div className="pt-1">{missingBase.map(missingRow)}</div>}
      </section>

      {/* CLI */}
      <section className="space-y-1.5">
        <h4 className="text-[length:var(--text-caption)] font-medium text-[var(--app-text-tertiary)]">
          {installedClis.length > 0
            ? t("environment.cliFound", { count: installedClis.length })
            : t("environment.cliNone")}
        </h4>
        {installedClis.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {installedClis.map((probe) => (
              <Chip key={probe.id} probe={probe} />
            ))}
          </div>
        )}
        {promoted.length > 0 && <div>{promoted.map(missingRow)}</div>}
        {folded.length > 0 && (
          <div>
            <button
              type="button"
              aria-expanded={moreOpen}
              className="-mx-1 flex items-center gap-1 rounded px-1 py-0.5 text-xs text-[var(--app-text-tertiary)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-secondary)]"
              onClick={() => setMoreOpen((v) => !v)}
            >
              {moreOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              {t("environment.installMore", { count: folded.length })}
            </button>
            {moreOpen && (
              <div className="mt-1 max-h-48 overflow-y-auto pl-5 pr-1">{folded.map(missingRow)}</div>
            )}
          </div>
        )}
      </section>

      {copyError && <p className="text-xs text-[var(--app-status-danger)]">{t("environment.copyFailed")}</p>}
    </div>
  );
}

function Chip({ probe }: { probe: ProbeItem }) {
  const Icon = probe.installed ? Check : X;
  return (
    <span
      title={probe.version ?? undefined}
      className="inline-flex items-center gap-1 rounded-md border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-2 py-0.5 text-xs text-[var(--app-text-primary)]"
    >
      <Icon
        className="size-3"
        style={{ color: probe.installed ? "var(--app-status-success)" : "var(--app-status-danger)" }}
        aria-hidden="true"
      />
      {probe.label}
    </span>
  );
}

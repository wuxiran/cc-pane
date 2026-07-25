import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Copy, Loader2, MinusCircle, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { EnvironmentInfo } from "@/types";

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
  applicable: boolean;
  repairCommand?: string;
}

function repairCommand(id: string): string | undefined {
  const windows = typeof navigator !== "undefined" && /Win/i.test(navigator.platform);
  const commands: Record<string, string> = windows
    ? {
        node: "winget install OpenJS.NodeJS.LTS",
        git: "winget install --id Git.Git -e",
        wsl: "wsl --install",
        claude: "npm install -g @anthropic-ai/claude-code",
        codex: "npm install -g @openai/codex",
      }
    : {
        node: "nvm install --lts",
        git: "sudo apt install git",
        claude: "npm install -g @anthropic-ai/claude-code",
        codex: "npm install -g @openai/codex",
      };
  return commands[id];
}

function buildProbeItems(environment: EnvironmentInfo | null): ProbeItem[] {
  if (!environment) return [];
  const base: ProbeItem[] = [
    {
      id: "node",
      label: "Node.js",
      installed: environment.node.installed,
      version: environment.node.version,
      applicable: true,
      repairCommand: repairCommand("node"),
    },
    {
      id: "git",
      label: "Git",
      installed: environment.git?.installed ?? false,
      version: environment.git?.version ?? null,
      applicable: true,
      repairCommand: repairCommand("git"),
    },
    {
      id: "wsl",
      label: "WSL",
      installed: environment.wsl?.installed ?? false,
      version: environment.wsl?.version ?? null,
      applicable: environment.wsl?.applicable ?? false,
      repairCommand: repairCommand("wsl"),
    },
  ];
  return [
    ...base,
    ...environment.cliTools.map((tool) => ({
      id: tool.id,
      label: tool.displayName,
      installed: tool.installed,
      version: tool.version,
      applicable: true,
      repairCommand: repairCommand(tool.id),
    })),
  ];
}

export default function EnvironmentPreflightCard({
  environment,
  checking,
  error,
}: EnvironmentPreflightCardProps) {
  const { t } = useTranslation("onboarding");
  const [copyState, setCopyState] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  const probes = buildProbeItems(environment);

  const copyRepair = async (probe: ProbeItem) => {
    if (!probe.repairCommand || !navigator.clipboard) {
      setCopyError(true);
      return;
    }
    try {
      await navigator.clipboard.writeText(probe.repairCommand);
      setCopyState(probe.id);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  };

  if (checking) {
    return (
      <div className="flex min-h-28 items-center justify-center gap-2 text-sm text-[var(--app-text-secondary)]">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {t("environment.checking")}
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-[var(--app-status-danger)]">{error}</p>;
  }

  return (
    <div className="space-y-2">
      {probes.map((probe) => {
        const missing = probe.applicable && !probe.installed;
        return (
          <div
            key={probe.id}
            className="flex min-h-11 items-center gap-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-3 py-2"
          >
            {!probe.applicable ? (
              <MinusCircle className="size-4 shrink-0 text-[var(--app-text-tertiary)]" aria-hidden="true" />
            ) : probe.installed ? (
              <CheckCircle2 className="size-4 shrink-0 text-[var(--app-status-success)]" aria-hidden="true" />
            ) : (
              <XCircle className="size-4 shrink-0 text-[var(--app-status-danger)]" aria-hidden="true" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-[var(--app-text-primary)]">{probe.label}</p>
              <p className="truncate text-[11px] text-[var(--app-text-tertiary)]">
                {!probe.applicable
                  ? t("environment.notApplicable")
                  : probe.installed
                    ? probe.version || t("environment.installed")
                    : t("environment.missing")}
              </p>
            </div>
            {missing && probe.repairCommand && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 shrink-0 gap-1.5 px-2.5 text-xs"
                aria-label={t("environment.copyRepair", { name: probe.label })}
                onClick={() => void copyRepair(probe)}
              >
                <Copy className="size-3.5" aria-hidden="true" />
                {copyState === probe.id ? t("environment.copied") : t("environment.copy")}
              </Button>
            )}
          </div>
        );
      })}
      {copyError && (
        <p className="text-xs text-[var(--app-status-danger)]">{t("environment.copyFailed")}</p>
      )}
    </div>
  );
}

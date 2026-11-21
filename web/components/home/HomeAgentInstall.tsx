// 首页「安装其他 Agent（n）」：推荐下载各种 CLI（参考 magpie）。可折叠，默认展开。
// 只列本机还没装的；装好后窗口回到前台会重新检测，条目自动移到上面的 Agent 列表。
// 「安装」在应用内开一个 shell 标签直接执行命令（installTerminal.ts），不再让用户自己去粘贴。
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronDown, CheckCircle2 } from "lucide-react";
import { terminalService, terminalPathLinkService } from "@/services";
import { useWorkspacesStore } from "@/stores";
import type { CliToolInfo, EnvironmentInfo, OpenTerminalOptions, PackageManagerId } from "@/types";
import { cn } from "@/lib/utils";
import { toastErr, toastInfo } from "@/lib/feedback";
import { handleErrorSilent } from "@/utils/errorHandler";
import { currentInstallPlatform, installMethodsFor, pendingCatalogEntries, terminalRunCommand } from "./agentCatalog";
import { resolveDefaultAgentCwd } from "./agentPromptLaunch";
import { runCommandInNewTerminal } from "./installTerminal";
import HomeAgentInstallRow, { RunCommandButton } from "./HomeAgentInstallRow";

interface HomeAgentInstallProps {
  installedTools: readonly CliToolInfo[];
  /** 首次检测完成前不渲染，避免把已装的 CLI 当成「待安装」闪一下。 */
  ready: boolean;
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
}

const HOMEBREW_INSTALL = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
const GIT_HINT: Record<string, string> = {
  mac: "xcode-select --install",
  linux: "sudo apt install git",
  windows: "winget install --id Git.Git -e",
};
/** 「已检测到」一行里展示的工具名（按平台挑有意义的）。 */
const SHOWN_MANAGERS: Record<string, readonly PackageManagerId[]> = {
  mac: ["brew", "npm", "bun", "curl"],
  linux: ["brew", "npm", "bun", "curl"],
  windows: ["winget", "scoop", "npm", "bun"],
};
const MANAGER_LABEL: Record<PackageManagerId, string> = {
  brew: "Homebrew",
  npm: "npm",
  bun: "Bun",
  curl: "curl",
  winget: "winget",
  scoop: "Scoop",
};

function nodeHint(platform: string, managers: EnvironmentInfo["packageManagers"]): string {
  if (platform === "windows") return "winget install OpenJS.NodeJS.LTS";
  if (managers?.brew) return "brew install node";
  return platform === "mac" ? HOMEBREW_INSTALL : "nvm install --lts";
}

/** 模块级缓存：跨挂载复用；窗口回到前台时重测（用户可能刚在终端里装了 brew/node）。 */
let cachedEnvironment: EnvironmentInfo | null = null;

function useEnvironmentInfo(): EnvironmentInfo | null {
  const [info, setInfo] = useState<EnvironmentInfo | null>(cachedEnvironment);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      terminalService
        .checkEnvironment()
        .then((next) => {
          cachedEnvironment = next;
          if (!cancelled) setInfo(next);
        })
        .catch((error) => handleErrorSilent(error, "check environment for agent install"));
    };
    if (!cachedEnvironment) load();
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", load);
    };
  }, []);
  return info;
}

interface MissingItem {
  label: string;
  command: string;
}

export default function HomeAgentInstall({ installedTools, ready, onOpenTerminal }: HomeAgentInstallProps) {
  const { t } = useTranslation("home");
  const [expanded, setExpanded] = useState(true);
  const environment = useEnvironmentInfo();
  const managers = environment?.packageManagers;
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const expandedWorkspaceId = useWorkspacesStore((s) => s.expandedWorkspaceId);
  const expandedProjectId = useWorkspacesStore((s) => s.expandedProjectId);
  const platform = currentInstallPlatform();

  const pending = useMemo(
    () => pendingCatalogEntries(new Set(installedTools.map((tool) => tool.id)), platform),
    [installedTools, platform],
  );
  const terminalCwd = resolveDefaultAgentCwd(workspaces, expandedWorkspaceId, expandedProjectId);

  const runInTerminal = useCallback(
    async (command: string) => {
      if (!terminalCwd) return;
      try {
        const result = await runCommandInNewTerminal(
          () => onOpenTerminal({ path: terminalCwd }),
          terminalRunCommand(command, platform),
        );
        if (result === "no-terminal") {
          await navigator.clipboard?.writeText(command).catch(() => undefined);
          toastInfo(t("install.runFallbackToast"));
        }
      } catch (error) {
        toastErr(t("install.runFailed", { error: String(error) }));
      }
    },
    [onOpenTerminal, platform, t, terminalCwd],
  );

  if (!ready) return null;

  const openHomepage = (url: string) => {
    terminalPathLinkService.openExternalUrl(url).catch((error) => handleErrorSilent(error, "open agent homepage"));
  };

  const missing = [
    platform === "mac" && managers && managers.brew === false
      ? { label: t("install.missingBrew"), command: HOMEBREW_INSTALL }
      : null,
    environment && !environment.node.installed ? { label: t("install.missingNode"), command: nodeHint(platform, managers) } : null,
    environment?.git && !environment.git.installed ? { label: t("install.missingGit"), command: GIT_HINT[platform] } : null,
  ].filter((item): item is MissingItem => item !== null);
  // 没装 brew 时 Node 提示给的也是装 brew 的命令，去重只留一条。
  const uniqueMissing = missing.filter((item, index) => missing.findIndex((other) => other.command === item.command) === index);
  const detected = managers ? SHOWN_MANAGERS[platform].filter((id) => managers[id]) : [];
  const canRun = terminalCwd ? runInTerminal : undefined;

  return (
    <section data-testid="home-agent-install" aria-label={t("install.title", { count: pending.length })}>
      <button
        type="button"
        aria-expanded={expanded}
        className="flex items-center gap-1.5 px-1 text-[length:var(--text-body)] text-[var(--app-text-secondary)] transition-colors hover:text-[var(--app-text-primary)]"
        onClick={() => setExpanded((value) => !value)}
      >
        {t("install.title", { count: pending.length })}
        <ChevronDown className={cn("size-4 transition-transform duration-[var(--dur-fast)]", !expanded && "-rotate-90")} aria-hidden="true" />
      </button>

      {expanded && (
        <div className="mt-2 space-y-3">
          <p className="px-1 text-[length:var(--text-small)] text-[var(--app-text-tertiary)]">
            {t("install.hint")}
            {managers && (
              <span data-testid="home-agent-install-detected">
                {" "}
                {detected.length > 0
                  ? t("install.detected", { tools: detected.map((id) => MANAGER_LABEL[id]).join(" · ") })
                  : t("install.detectedNone")}
              </span>
            )}
          </p>
          {uniqueMissing.map((item) => (
            <div
              key={item.command}
              role="status"
              className="flex flex-wrap items-center gap-2 rounded-xl border border-[color-mix(in_srgb,var(--app-status-warning)_35%,transparent)] bg-[color-mix(in_srgb,var(--app-status-warning)_8%,transparent)] px-4 py-2.5 text-[length:var(--text-small)] text-[var(--app-text-secondary)]"
            >
              <AlertTriangle className="size-4 shrink-0 text-[var(--app-status-warning)]" aria-hidden="true" />
              {item.label}
              <code className="min-w-0 truncate rounded bg-[var(--app-hover)] px-2 py-0.5 font-mono text-[var(--app-text-primary)]" title={item.command}>
                {item.command}
              </code>
              {canRun && <RunCommandButton onRun={() => void canRun(item.command)} />}
            </div>
          ))}
          {pending.length === 0 ? (
            <p className="flex items-center gap-2 px-1 text-[length:var(--text-small)] text-[var(--app-text-tertiary)]">
              <CheckCircle2 className="size-4 text-[var(--app-status-success)]" aria-hidden="true" />
              {t("install.allInstalled")}
            </p>
          ) : (
            <ul className="space-y-3">
              {pending.map((entry) => (
                <HomeAgentInstallRow
                  key={entry.id}
                  entry={entry}
                  methods={installMethodsFor(entry, platform, managers)}
                  available={managers}
                  onRun={canRun}
                  onOpenHomepage={openHomepage}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

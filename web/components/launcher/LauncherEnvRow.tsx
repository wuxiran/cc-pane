// 运行环境 segmented：local / wsl / ssh。手动目录来源时锁 local（无工作空间上下文可解析远端路径）。
import { useTranslation } from "react-i18next";
import type { CliTool, WorkspaceLaunchEnvironment } from "@/types";

const ENVIRONMENTS: WorkspaceLaunchEnvironment[] = ["local", "wsl", "ssh"];

/** The Pi family keeps its installation and native auth on the local/WSL host. */
export function getLauncherEnvironmentOptions(
  cliTool: CliTool | undefined,
): WorkspaceLaunchEnvironment[] {
  return cliTool === "pi" || cliTool === "omp"
    ? ENVIRONMENTS.filter((environment) => environment !== "ssh")
    : ENVIRONMENTS;
}

interface LauncherEnvRowProps {
  value: WorkspaceLaunchEnvironment;
  onChange: (environment: WorkspaceLaunchEnvironment) => void;
  cliTool?: CliTool;
  disabled?: boolean;
}

export default function LauncherEnvRow({
  value,
  onChange,
  cliTool,
  disabled,
}: LauncherEnvRowProps) {
  const { t } = useTranslation("launcher");
  const environments = getLauncherEnvironmentOptions(cliTool);
  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-lg border p-0.5"
      style={{ borderColor: "var(--app-border)" }}
      role="radiogroup"
      aria-label={t("environment")}
    >
      {environments.map((environment) => {
        const active = value === environment;
        return (
          <button
            key={environment}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            className="rounded-md px-3 py-1 text-[11.5px] font-medium transition-colors duration-[var(--dur-fast)] enabled:hover:bg-[var(--app-hover)] disabled:cursor-not-allowed disabled:opacity-40"
            style={
              active
                ? {
                    background: "color-mix(in srgb, var(--app-accent) 12%, transparent)",
                    color: "var(--app-accent)",
                  }
                : { color: "var(--app-text-secondary)" }
            }
            onClick={() => onChange(environment)}
          >
            {t(`env.${environment}`)}
          </button>
        );
      })}
    </div>
  );
}

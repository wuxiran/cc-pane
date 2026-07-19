import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, XCircle } from "lucide-react";
import { terminalService } from "@/services";
import { waitForTauri } from "@/utils";
import type { EnvironmentInfo } from "@/types";

/** 模块级缓存，跨组件挂载周期复用 */
let cachedEnvInfo: EnvironmentInfo | null = null;

export default function HomeEnvironment() {
  const { t } = useTranslation("home");
  const [envInfo, setEnvInfo] = useState<EnvironmentInfo | null>(cachedEnvInfo);
  const [loading, setLoading] = useState(!cachedEnvInfo);

  useEffect(() => {
    if (cachedEnvInfo) return;
    let cancelled = false;
    waitForTauri().then(async (ready) => {
      if (cancelled || !ready) return;
      try {
        const info = await terminalService.checkEnvironment();
        if (!cancelled) {
          cachedEnvInfo = info;
          setEnvInfo(info);
        }
      } catch (err) {
        console.error("Failed to check environment:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, []);

  const tools = envInfo
    ? [
        { id: "node", name: "Node.js", ...envInfo.node },
        ...envInfo.cliTools.map((t) => ({
          id: t.id,
          name: t.displayName,
          installed: t.installed,
          version: t.version,
        })),
      ]
    : [];

  return (
    <div>
      <h3
        className="text-sm font-semibold mb-3"
        style={{ color: "var(--app-text-primary)" }}
      >
        {t("environment")}
      </h3>
      <div
        className="rounded-2xl overflow-hidden border border-[var(--app-home-border)] bg-[var(--app-home-surface)]"
      >
        {loading ? (
          /* 骨架屏 */
          <div className="flex flex-col gap-0">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="flex items-center gap-3 px-5 py-3.5 border-b border-[var(--app-home-row-border)] last:border-b-0"
              >
                <div
                  className="w-7 h-7 rounded-lg animate-pulse"
                  style={{ background: "var(--app-hover)" }}
                />
                <div className="flex-1 flex flex-col gap-1">
                  <div
                    className="h-3 w-16 rounded animate-pulse"
                    style={{ background: "var(--app-hover)" }}
                  />
                </div>
                <div
                  className="h-5 w-14 rounded-full animate-pulse"
                  style={{ background: "var(--app-hover)" }}
                />
              </div>
            ))}
          </div>
        ) : (
          tools.map((tool) => {
            const stateColor = tool.installed ? "var(--chart-2)" : "var(--destructive)";
            return (
              <div
                key={tool.name}
                className="flex items-center gap-3 px-5 py-3.5 border-b border-[var(--app-home-row-border)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-home-surface-hover)] last:border-b-0"
              >
                {/* 图标容器 */}
                <div
                  className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
                  style={{
                    background: `color-mix(in srgb, ${stateColor} 12%, transparent)`,
                  }}
                >
                  {tool.installed ? (
                    <CheckCircle2
                      className="w-4 h-4"
                      style={{ color: "var(--chart-2)" }}
                    />
                  ) : (
                    <XCircle
                      className="w-4 h-4"
                      style={{ color: "var(--destructive)" }}
                    />
                  )}
                </div>
                <span
                  className="text-sm flex-1"
                  style={{ color: "var(--app-text-primary)" }}
                >
                  {tool.name}
                </span>
                {/* Pill badge */}
                {tool.installed ? (
                  <span
                    className="px-2.5 py-1 rounded-full border text-xs font-mono"
                    style={{
                      background: "color-mix(in srgb, var(--chart-2) 10%, transparent)",
                      borderColor: "color-mix(in srgb, var(--chart-2) 16%, transparent)",
                      color: "var(--chart-2)",
                    }}
                  >
                    {tool.version ?? t("installed")}
                  </span>
                ) : (
                  <span
                    className="px-2.5 py-1 rounded-full border text-xs"
                    style={{
                      background: "color-mix(in srgb, var(--destructive) 10%, transparent)",
                      borderColor: "color-mix(in srgb, var(--destructive) 16%, transparent)",
                      color: "var(--destructive)",
                    }}
                  >
                    {t("notInstalled")}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

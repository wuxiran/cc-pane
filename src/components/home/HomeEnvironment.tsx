import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, XCircle } from "lucide-react";
import { terminalService } from "@/services";
import { waitForTauri } from "@/utils";
import type { EnvironmentInfo } from "@/types";

/** 模块级缓存，跨组件挂载周期复用 */
let cachedEnvInfo: EnvironmentInfo | null = null;

/** 各工具的主题色 */
const TOOL_COLORS: Record<string, string> = {
  "Node.js": "#22c55e",
  "Claude CLI": "var(--app-accent)",
  "Codex CLI": "#a855f7",
};

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
        { name: "Node.js", ...envInfo.node },
        { name: "Claude CLI", ...envInfo.claude },
        { name: "Codex CLI", ...envInfo.codex },
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
        className="rounded-xl overflow-hidden"
        style={{
          background: "var(--app-glass-bg)",
          border: "1px solid var(--app-border)",
        }}
      >
        {loading ? (
          /* 骨架屏 */
          <div className="flex flex-col gap-0">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="flex items-center gap-3 px-3 py-2.5"
                style={{ borderBottom: i < 2 ? "1px solid var(--app-border)" : undefined }}
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
          tools.map((tool, i) => {
            const color = TOOL_COLORS[tool.name] ?? "var(--app-text-tertiary)";
            return (
              <div
                key={tool.name}
                className="flex items-center gap-3 px-3 py-2.5"
                style={{ borderBottom: i < tools.length - 1 ? "1px solid var(--app-border)" : undefined }}
              >
                {/* 图标容器 */}
                <div
                  className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                  style={{
                    background: `color-mix(in srgb, ${color} 12%, transparent)`,
                  }}
                >
                  {tool.installed ? (
                    <CheckCircle2
                      className="w-3.5 h-3.5"
                      style={{ color }}
                    />
                  ) : (
                    <XCircle
                      className="w-3.5 h-3.5"
                      style={{ color: "#ef4444" }}
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
                    className="px-2 py-0.5 rounded-full text-xs font-mono"
                    style={{
                      background: "color-mix(in srgb, #22c55e 10%, transparent)",
                      color: "#22c55e",
                    }}
                  >
                    {tool.version ?? t("installed")}
                  </span>
                ) : (
                  <span
                    className="px-2 py-0.5 rounded-full text-xs"
                    style={{
                      background: "color-mix(in srgb, #ef4444 10%, transparent)",
                      color: "#ef4444",
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

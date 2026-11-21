// MCP 详情里的「会送到哪些 CLI」（docs/110 批 5）：按运行时列出，数据只来自 CLI 注入描述。
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { mcpReachByRuntime, type McpReachRuntime, type McpReachSource } from "@/lib/mcpReach";
import { useCliInjectionProfilesStore } from "@/stores/useCliInjectionProfilesStore";
import type { McpLibraryEntry } from "./mcpLibraryModel";

export function reachSourceOf(entry: McpLibraryEntry): McpReachSource {
  switch (entry.kind) {
    case "ccpanes":
      return { kind: "ccpanes" };
    case "shared": {
      const remote = entry.server.config.remote;
      return {
        kind: "shared",
        remote: remote ? { transport: remote.transport, hasHeaders: Object.keys(remote.headers).length > 0 } : null,
      };
    }
    case "layer":
      return { kind: "layer", http: Boolean(entry.config.url) };
  }
}

const RUNTIMES: McpReachRuntime[] = ["local", "wsl", "ssh"];

export default function McpReachList({ entry }: { entry: McpLibraryEntry }) {
  const { t } = useTranslation("settings");
  const profiles = useCliInjectionProfilesStore((state) => state.profiles);
  const reach = useMemo(() => mcpReachByRuntime(profiles, reachSourceOf(entry)), [profiles, entry]);

  return (
    <div className="space-y-1.5 border-t pt-3" style={{ borderColor: "var(--app-border)" }} data-testid="mcp-reach">
      <p className="text-[length:var(--text-small)] font-medium" style={{ color: "var(--app-text-secondary)" }}>
        {t("resourceLibrary.reachTitle")}
      </p>
      {RUNTIMES.map((runtime) => (
        <div key={runtime} className="flex flex-wrap items-center gap-1" data-testid={`mcp-reach-${runtime}`}>
          <span className="w-12 shrink-0 text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>
            {t(`resourceLibrary.reachRuntime.${runtime}`)}
          </span>
          {reach[runtime].length === 0 ? (
            <span className="text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>
              {t(runtime === "ssh" ? "resourceLibrary.reachSshNone" : "resourceLibrary.reachNone")}
            </span>
          ) : (
            reach[runtime].map((cli) => (
              <Badge key={cli} variant="outline" className="font-mono text-[length:var(--text-micro)]">{cli}</Badge>
            ))
          )}
        </div>
      ))}
    </div>
  );
}

// 启动档 MCP 卡片 · 投递方式（docs/113）：直连 = 每台共享服务器一条；Hub = 只给一条 ccpanes-hub。
// 与模式（给哪些）正交。能否用 hub 读 CLI 注入描述（hubDeliverySupported），与后端同口径；
// 不支持的组合在启动时自动回退直连，这里置灰并说明原因。
import { useTranslation } from "react-i18next";
import { SegmentedTabs } from "@/components/ui/segmented";
import { hubCanRoute, hubDeliverySupported } from "@/lib/cliInjectionRules";
import type { InjectionProfile } from "@/types/cliInjectionProfile";
import type { McpDelivery } from "@/types/launch-profile";
import type { SharedMcpServerInfo } from "@/types/shared-mcp";

export type HubFallbackReason = "cli" | "runtime" | "sse";

/** 选了 hub 时，哪些情况会回退直连（只列和当前机器 / 资源库有关的）。 */
export function hubFallbackReasons(
  profile: InjectionProfile | null | undefined,
  remoteRuntimes: readonly string[],
  sharedServers: readonly SharedMcpServerInfo[],
): HubFallbackReason[] {
  const reasons: HubFallbackReason[] = [];
  if (!hubDeliverySupported(profile, null)) reasons.push("cli");
  if (remoteRuntimes.some((runtime) => !hubDeliverySupported(profile, runtime)) && !reasons.includes("cli")) {
    reasons.push("runtime");
  }
  if (sharedServers.some((server) => server.config.shared && !hubCanRoute(server.config.remote))) reasons.push("sse");
  return reasons;
}

export function McpDeliveryTabs({
  value,
  onChange,
  hubSupported,
}: {
  value: McpDelivery;
  onChange: (next: McpDelivery) => void;
  hubSupported: boolean;
}) {
  const { t } = useTranslation("providers");
  return (
    <SegmentedTabs
      size="sm"
      value={value}
      onValueChange={onChange}
      aria-label={t("mcpDelivery.label")}
      items={(["direct", "hub"] as const).map((delivery) => ({
        value: delivery,
        label: t(`mcpDelivery.${delivery}`),
        // 已经选了 hub 的启动档仍能看到选中态，只是不能新选
        disabled: delivery === "hub" && !hubSupported && value !== "hub",
      }))}
    />
  );
}

export function McpDeliveryNote({ value, reasons }: { value: McpDelivery; reasons: readonly HubFallbackReason[] }) {
  const { t } = useTranslation("providers");
  return (
    <div className="mb-2 space-y-0.5 text-[length:var(--text-caption)]" style={{ color: "var(--app-text-tertiary)" }} data-testid="mcp-delivery-note">
      <div>{t("mcpDelivery.desc")}</div>
      {reasons.map((reason) => (
        <div key={reason} data-testid={`mcp-delivery-fallback-${reason}`}>
          {t(value === "hub" ? "mcpDelivery.fallbackLine" : "mcpDelivery.limitLine", { reason: t(`mcpDelivery.fallback.${reason}`) })}
        </div>
      ))}
    </div>
  );
}

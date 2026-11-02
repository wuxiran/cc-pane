import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  Globe,
  Network,
  Server,
  TriangleAlert,
} from "lucide-react";
import { buildSshRoutePreview, type SshRouteHop } from "@/lib/sshRoutePreview";
import type { SshMachine } from "@/types";

function HopIcon({ hop }: { hop: SshRouteHop }) {
  if (hop.type === "proxy") return <Globe className="h-3.5 w-3.5" />;
  if (hop.type === "jump") return <Network className="h-3.5 w-3.5" />;
  return <Server className="h-3.5 w-3.5" />;
}

interface SshRoutePreviewProps {
  machine: Pick<SshMachine, "host" | "port" | "proxy" | "jumpHost">;
  machines: readonly SshMachine[];
}

/**
 * 连接路由预览：把当前路由按「代理 → 跳板 → 目标」可视化成一串跳。
 *
 * 纯客户端派生（`buildSshRoutePreview`），与后端 `open_routed_stream` 的跳序一致，
 * 不联网、不注册新 Tauri 命令。引用式跳板指向缺失机器或嵌套跳板时给出告警。
 */
export function SshRoutePreview({ machine, machines }: SshRoutePreviewProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const preview = buildSshRoutePreview(machine, machines);

  const labelFor = (hop: SshRouteHop): string => {
    if (hop.type === "proxy") {
      const kind =
        hop.proxyKind === "http"
          ? t("ssh.route.proxyHttp", { defaultValue: "HTTP proxy" })
          : t("ssh.route.proxySocks5", { defaultValue: "SOCKS5 proxy" });
      return kind;
    }
    if (hop.type === "jump") {
      return hop.machineName
        ? t("ssh.route.jumpNamed", {
            defaultValue: "Jump: {{name}}",
            name: hop.machineName,
          })
        : t("ssh.route.jump", { defaultValue: "Jump host" });
    }
    return t("ssh.route.target", { defaultValue: "Target" });
  };

  return (
    <div className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg-secondary)] p-2">
      <div className="mb-1.5 text-[length:var(--text-micro)] font-medium uppercase tracking-wide text-[var(--app-text-muted)]">
        {preview.direct
          ? t("ssh.route.direct", { defaultValue: "Direct connection" })
          : t("ssh.route.title", { defaultValue: "Connection route" })}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {preview.hops.map((hop, index) => (
          <div key={`${hop.type}-${index}`} className="flex items-center gap-1.5">
            {index > 0 && (
              <ArrowRight className="h-3 w-3 shrink-0 text-[var(--app-text-muted)]" />
            )}
            <span
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[length:var(--text-caption)] text-[var(--app-text-primary)]"
              style={{ background: "var(--app-hover)" }}
              title={hop.endpoint}
            >
              <HopIcon hop={hop} />
              <span>{labelFor(hop)}</span>
              <span className="text-[length:var(--text-micro)] text-[var(--app-text-muted)]">
                {hop.endpoint}
              </span>
            </span>
          </div>
        ))}
      </div>
      {preview.warnings.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1">
          {preview.warnings.map((warning) => (
            <span
              key={`${warning.code}-${warning.machineId}`}
              className="inline-flex items-center gap-1 text-[length:var(--text-micro)] text-[var(--app-status-warning)]"
            >
              <TriangleAlert className="h-3 w-3 shrink-0" />
              {warning.code === "jumpMachineMissing"
                ? t("ssh.route.warningMissingJump", {
                    defaultValue:
                      "Referenced jump machine no longer exists; it will be skipped.",
                  })
                : t("ssh.route.warningNestedJump", {
                    defaultValue:
                      "The referenced jump machine has its own jump host; nested jumps are not supported.",
                  })}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

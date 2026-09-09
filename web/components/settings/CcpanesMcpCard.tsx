import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { mcpService } from "@/services";

function CopyRow({
  label,
  value,
  copied,
  onCopy,
  title,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
  title: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] text-muted-foreground w-10 shrink-0">{label}</span>
      <code className="flex-1 text-[10px] font-mono bg-muted rounded px-1.5 py-0.5 truncate">
        {value}
      </code>
      <Button size="icon" variant="ghost" className="h-5 w-5 shrink-0" onClick={onCopy} title={title}>
        {copied ? <Check size={10} className="text-[var(--app-status-success)]" /> : <Copy size={10} />}
      </Button>
    </div>
  );
}

export default function CcpanesMcpCard() {
  const { t } = useTranslation(["settings", "common"]);
  const [info, setInfo] = useState<{ port: number | null; token: string } | null>(null);
  const [copied, setCopied] = useState<"core" | "full" | "token" | null>(null);

  useEffect(() => {
    mcpService.getOrchestratorInfo().then(setInfo).catch(() => {});
  }, []);

  if (!info || !info.port) return null;

  const coreUrl = `http://127.0.0.1:${info.port}/mcp?token=${info.token}`;
  const fullUrl = `http://127.0.0.1:${info.port}/mcp-full?token=${info.token}`;

  function copy(kind: "core" | "full" | "token", text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Zap size={14} className="text-primary shrink-0" />
        <span className="text-xs font-medium">{t("sharedMcp.selfTitle")}</span>
        <Badge variant="secondary" className="text-[10px]">HTTP</Badge>
      </div>
      <p className="text-[10px] leading-4 text-muted-foreground">{t("sharedMcp.selfHint")}</p>
      <div className="space-y-1.5">
        <CopyRow label={t("sharedMcp.coreUrl")} value={coreUrl} copied={copied === "core"} onCopy={() => copy("core", coreUrl)} title={t("sharedMcp.copyUrl")} />
        <CopyRow label={t("sharedMcp.fullUrl")} value={fullUrl} copied={copied === "full"} onCopy={() => copy("full", fullUrl)} title={t("sharedMcp.copyUrl")} />
        <CopyRow label="Token" value={info.token} copied={copied === "token"} onCopy={() => copy("token", info.token)} title={t("sharedMcp.copyToken")} />
      </div>
    </div>
  );
}

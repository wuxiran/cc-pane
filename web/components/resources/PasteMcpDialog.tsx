// 粘贴添加 MCP：识别 README 里的 JSON，确认名称和目标层后写入。写入只走现有 store。
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toastErr, toastOk } from "@/lib/feedback";
import { EMPTY_MCP_LAYER, useMcpStore } from "@/stores/useMcpStore";
import { useSharedMcpStore } from "@/stores/useSharedMcpStore";
import { mcpTargetKey, type McpLayerTarget } from "@/types";
import { translateError } from "@/utils";
import { maskSensitiveValue, normalizeMcpName, parseMcpPaste, type PastedMcpServer } from "./pasteMcpConfig";
import { nextSharedPorts, pasteRowProblem } from "./resourceCenterModel";

interface PasteMcpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前选中的工作空间/项目层；没有时只能加到共享 */
  layerTarget: McpLayerTarget | null;
  layerLabel: string | null;
}

type TargetKind = "shared" | "layer";

export default function PasteMcpDialog({ open, onOpenChange, layerTarget, layerLabel }: PasteMcpDialogProps) {
  const { t } = useTranslation("settings");
  const { t: tCommon } = useTranslation("common");
  const sharedServers = useSharedMcpStore((s) => s.servers);
  const sharedConfig = useSharedMcpStore((s) => s.config);
  const fetchSharedConfig = useSharedMcpStore((s) => s.fetchConfig);
  const upsertShared = useSharedMcpStore((s) => s.upsertServer);
  const upsertLayer = useMcpStore((s) => s.upsertServer);
  const layerServers = useMcpStore((s) => (layerTarget ? s.layers[mcpTargetKey(layerTarget)] ?? EMPTY_MCP_LAYER : EMPTY_MCP_LAYER).servers);

  const [text, setText] = useState("");
  const [targetKind, setTargetKind] = useState<TargetKind>("shared");
  const [names, setNames] = useState<Record<number, string>>({});
  const [unchecked, setUnchecked] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) void fetchSharedConfig();
  }, [open, fetchSharedConfig]);

  const parsed = useMemo(() => parseMcpPaste(text), [text]);
  const servers: PastedMcpServer[] = parsed.ok ? parsed.servers : [];
  const existing = useMemo(
    () => new Set(targetKind === "shared" ? sharedServers.map((server) => server.name) : Object.keys(layerServers)),
    [targetKind, sharedServers, layerServers],
  );

  const reset = () => {
    setText("");
    setNames({});
    setUnchecked(new Set());
    setTargetKind("shared");
  };

  const rows = servers.map((server, index) => {
    const name = normalizeMcpName(names[index] ?? server.name);
    const problem = pasteRowProblem({ name, url: server.url }, existing);
    return { server, index, name, problem, selected: !problem && !unchecked.has(index) };
  });
  const selected = rows.filter((row) => row.selected);
  const duplicateInPaste = new Set(selected.map((row) => row.name)).size !== selected.length;
  const parseError = !parsed.ok && parsed.error !== "empty" ? parsed.error : null;

  async function handleAdd() {
    setSaving(true);
    const failed: string[] = [];
    let ports: number[] = [];
    if (targetKind === "shared") {
      // 端口范围要等配置读回来；读不到就不写，也不猜一个范围
      try {
        if (!sharedConfig) throw new Error(t("resourceCenter.paste.configNotReady"));
        ports = nextSharedPorts(
          sharedServers.map((server) => server.config.port),
          selected.length,
          { start: sharedConfig.portRangeStart, end: sharedConfig.portRangeEnd },
        );
      } catch (error) {
        setSaving(false);
        toastErr(t("resourceCenter.paste.failed", { error: translateError(error) }));
        return;
      }
    }
    for (const [position, { server, name }] of selected.entries()) {
      try {
        if (targetKind === "shared") {
          await upsertShared(name, {
            command: server.command,
            args: server.args,
            env: server.env,
            shared: true,
            port: ports[position],
            bridgeMode: "mcp-proxy",
          });
        } else if (layerTarget) {
          await upsertLayer(layerTarget, name, server.command, server.args, server.env);
        }
      } catch (error) {
        failed.push(`${name}: ${translateError(error)}`);
      }
    }
    setSaving(false);
    const added = selected.length - failed.length;
    if (added > 0) toastOk(t("resourceCenter.paste.added", { count: added }));
    if (failed.length > 0) {
      toastErr(t("resourceCenter.paste.failed", { error: failed.join("; ") }));
      return;
    }
    reset();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-base">{t("resourceCenter.paste.title")}</DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">{t("resourceCenter.paste.hint")}</DialogDescription>
        </DialogHeader>

        <textarea
          aria-label={t("resourceCenter.paste.inputLabel")}
          data-testid="mcp-paste-input"
          value={text}
          onChange={(event) => { setText(event.target.value); setNames({}); setUnchecked(new Set()); }}
          placeholder={'{ "mcpServers": { "github": { "command": "npx", "args": ["-y", "..."] } } }'}
          spellCheck={false}
          className="h-28 w-full resize-none rounded-md border border-input bg-background px-3 py-2 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        />
        {parseError && (
          <p className="text-xs" style={{ color: "var(--app-status-danger)" }} data-testid="mcp-paste-error">
            {t(`resourceCenter.paste.error.${parseError}`)}
          </p>
        )}

        {rows.length > 0 && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-xs" role="radiogroup" aria-label={t("resourceCenter.paste.target")}>
              <span style={{ color: "var(--app-text-secondary)" }}>{t("resourceCenter.paste.target")}</span>
              <Button size="sm" variant={targetKind === "shared" ? "secondary" : "ghost"} className="h-7 text-xs" role="radio" aria-checked={targetKind === "shared"} onClick={() => setTargetKind("shared")}>
                {t("resourceCenter.paste.targetShared")}
              </Button>
              {layerTarget && (
                <Button size="sm" variant={targetKind === "layer" ? "secondary" : "ghost"} className="h-7 text-xs" role="radio" aria-checked={targetKind === "layer"} onClick={() => setTargetKind("layer")}>
                  {t("resourceCenter.paste.targetLayer", { name: layerLabel })}
                </Button>
              )}
            </div>

            <ul className="app-scrollbar max-h-64 space-y-1.5 overflow-y-auto">
              {rows.map(({ server, index, name, problem, selected: isSelected }) => (
                <li key={index} className="rounded-lg border p-2.5" style={{ borderColor: "var(--app-home-border)" }} data-testid="mcp-paste-row">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={isSelected}
                      disabled={Boolean(problem)}
                      aria-label={name || t("resourceCenter.paste.nameLabel")}
                      onCheckedChange={(checked) => setUnchecked((current) => {
                        const next = new Set(current);
                        if (checked) next.delete(index); else next.add(index);
                        return next;
                      })}
                    />
                    <Input
                      aria-label={t("resourceCenter.paste.nameLabel")}
                      value={names[index] ?? server.name}
                      onChange={(event) => setNames((current) => ({ ...current, [index]: event.target.value }))}
                      placeholder={t("resourceCenter.paste.namePlaceholder")}
                      className="h-7 w-44 font-mono text-xs"
                    />
                    {problem && <Badge variant="outline" className="text-[10px]">{t(`resourceCenter.paste.problem.${problem}`)}</Badge>}
                  </div>
                  <p className="mt-1.5 break-all font-mono text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                    {server.url ?? [server.command, ...server.args].join(" ")}
                  </p>
                  {Object.entries(server.url ? server.headers ?? {} : server.env).map(([key, value]) => (
                    <p key={key} className="break-all font-mono text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                      {key}={maskSensitiveValue(key, value)}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
            {duplicateInPaste && (
              <p className="text-xs" style={{ color: "var(--app-status-danger)" }}>{t("resourceCenter.paste.duplicate")}</p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={() => { reset(); onOpenChange(false); }}>{tCommon("cancel")}</Button>
          <Button size="sm" data-testid="mcp-paste-add" disabled={saving || selected.length === 0 || duplicateInPaste} onClick={() => void handleAdd()}>
            {t("resourceCenter.paste.add", { count: selected.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

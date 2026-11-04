// 新增或编辑共享 MCP。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toastErr, toastOk } from "@/lib/feedback";
import { useSharedMcpStore } from "@/stores";
import type { BridgeMode, SharedMcpServerConfig, SharedMcpServerInfo } from "@/types";
import { formatEnvLines, parseEnvLines, translateError } from "@/utils";
import { nextSharedPorts } from "./resourceCenterModel";

interface FormState {
  name: string;
  command: string;
  args: string;
  env: string;
  shared: boolean;
  port: string;
  bridgeMode: BridgeMode;
}

function formFor(server: SharedMcpServerInfo | null, port: string): FormState {
  if (!server) return { name: "", command: "", args: "", env: "", shared: true, port, bridgeMode: "mcp-proxy" };
  return {
    name: server.name,
    command: server.config.command,
    args: server.config.args.join(" "),
    env: formatEnvLines(server.config.env),
    shared: server.config.shared,
    port: String(server.config.port),
    bridgeMode: server.config.bridgeMode,
  };
}

interface SharedMcpEditorDialogProps {
  open: boolean;
  /** null 表示新增 */
  server: SharedMcpServerInfo | null;
  onOpenChange: (open: boolean) => void;
}

export default function SharedMcpEditorDialog({ open, server, onOpenChange }: SharedMcpEditorDialogProps) {
  const { t } = useTranslation(["settings", "common"]);
  const servers = useSharedMcpStore((s) => s.servers);
  const config = useSharedMcpStore((s) => s.config);
  const fetchConfig = useSharedMcpStore((s) => s.fetchConfig);
  const upsertServer = useSharedMcpStore((s) => s.upsertServer);
  const removeServer = useSharedMcpStore((s) => s.removeServer);
  const [form, setForm] = useState<FormState>(() => formFor(server, ""));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) void fetchConfig();
  }, [open, fetchConfig]);

  useEffect(() => {
    if (!open) return;
    let port = "";
    if (!server && config) {
      try {
        port = String(nextSharedPorts(servers.map((item) => item.config.port), 1, { start: config.portRangeStart, end: config.portRangeEnd })[0]);
      } catch {
        // 端口段用完时留空，让用户手填
      }
    }
    setForm(formFor(server, port));
    // 只在打开时初始化；servers 轮询刷新不能冲掉正在填写的内容
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, server?.name, config?.portRangeStart, config?.portRangeEnd]);

  async function handleSave() {
    const name = form.name.trim();
    const command = form.command.trim();
    const port = Number.parseInt(form.port, 10);
    const others = servers.filter((item) => item.name !== server?.name);
    if (!name || !command) return toastErr(t("sharedMcp.nameCommandRequired"));
    if (!Number.isInteger(port) || port < 1 || port > 65535) return toastErr(t("sharedMcp.portInvalid"));
    if (others.some((item) => item.name === name)) return toastErr(t("sharedMcp.nameExists"));
    if (others.some((item) => item.config.port === port)) return toastErr(t("sharedMcp.portInUse"));

    const updated: SharedMcpServerConfig = {
      command,
      args: form.args.trim() ? form.args.trim().split(/\s+/) : [],
      env: parseEnvLines(form.env),
      shared: form.shared,
      port,
      bridgeMode: form.bridgeMode,
    };
    setSaving(true);
    try {
      if (server && server.name !== name) await removeServer(server.name);
      await upsertServer(name, updated);
      toastOk(server ? t("sharedMcp.updated") : t("sharedMcp.added"));
      onOpenChange(false);
    } catch (error) {
      toastErr(t("common:saveFailed", { error: translateError(error) }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" data-testid="shared-mcp-editor">
        <DialogHeader>
          <DialogTitle className="text-base">{server ? t("sharedMcp.editTitle") : t("sharedMcp.newTitle")}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <FormField label={t("sharedMcp.fieldName")} className="space-y-1" labelClassName="text-xs">
            {({ id }) => <Input id={id} value={form.name} placeholder="context7" className="h-8 text-sm" onChange={(e) => setForm({ ...form, name: e.target.value })} />}
          </FormField>
          <FormField label={t("sharedMcp.fieldCommand")} className="space-y-1" labelClassName="text-xs">
            {({ id }) => <Input id={id} value={form.command} placeholder="npx" className="h-8 font-mono text-sm" onChange={(e) => setForm({ ...form, command: e.target.value })} />}
          </FormField>
          <FormField label={t("sharedMcp.fieldArgs")} className="space-y-1" labelClassName="text-xs">
            {({ id }) => <Input id={id} value={form.args} placeholder="-y @upstash/context7-mcp" className="h-8 font-mono text-sm" onChange={(e) => setForm({ ...form, args: e.target.value })} />}
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label={t("sharedMcp.fieldPort")} className="space-y-1" labelClassName="text-xs">
              {({ id }) => <Input id={id} value={form.port} placeholder="3100" className="h-8 font-mono text-sm" onChange={(e) => setForm({ ...form, port: e.target.value })} />}
            </FormField>
            <FormField label={t("sharedMcp.fieldBridge")} className="space-y-1" labelClassName="text-xs">
              {({ id }) => (
                <Select value={form.bridgeMode} onValueChange={(next) => setForm({ ...form, bridgeMode: next as BridgeMode })}>
                  <SelectTrigger id={id} className="h-8 w-full text-[length:var(--text-row)]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mcp-proxy">mcp-proxy</SelectItem>
                    <SelectItem value="native-http">native-http</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </FormField>
          </div>
        </div>
        <FormField label={t("sharedMcp.fieldEnv")} className="space-y-1" labelClassName="text-xs">
          {({ id }) => (
            <textarea
              id={id}
              value={form.env}
              onChange={(e) => setForm({ ...form, env: e.target.value })}
              placeholder="KEY=VALUE"
              className="h-20 w-full resize-none rounded-md border border-input bg-background px-3 py-2 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />
          )}
        </FormField>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.shared} onChange={(e) => setForm({ ...form, shared: e.target.checked })} />
          {t("sharedMcp.enableShared")}
        </label>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>{t("common:cancel")}</Button>
          <Button size="sm" disabled={saving} onClick={() => void handleSave()}>{t("common:save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

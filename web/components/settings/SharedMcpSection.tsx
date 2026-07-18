import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  ServerOff,
  Play,
  Square,
  RotateCw,
  Trash2,
  SquarePen,
  Download,
  Loader2,
  ToggleLeft,
  ToggleRight,
  Copy,
  Check,
  Zap,
  Plus,
  Save,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSharedMcpStore } from "@/stores";
import type { BridgeMode, SharedMcpServerConfig, SharedMcpServerInfo, SharedMcpServerStatus } from "@/types";
import { mcpService } from "@/services";
import { formatEnvLines, parseEnvLines } from "@/utils";

interface FormState {
  name: string;
  command: string;
  args: string;
  env: string;
  shared: boolean;
  port: string;
  bridgeMode: BridgeMode;
}

const emptyForm: FormState = {
  name: "",
  command: "",
  args: "",
  env: "",
  shared: true,
  port: "",
  bridgeMode: "mcp-proxy",
};

function statusLabel(status: SharedMcpServerStatus): string {
  if (status === "Running") return "Running";
  if (status === "Stopped") return "Stopped";
  if (status === "Starting") return "Starting";
  if (typeof status === "object" && "Failed" in status)
    return `Failed: ${status.Failed.message}`;
  return "Unknown";
}

function statusVariant(
  status: SharedMcpServerStatus,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "Running") return "default";
  if (status === "Stopped") return "secondary";
  if (typeof status === "object" && "Failed" in status) return "destructive";
  return "outline";
}

function CcpanesMcpCard() {
  const { t } = useTranslation(["settings", "common"]);
  const [info, setInfo] = useState<{ port: number | null; token: string } | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedToken, setCopiedToken] = useState(false);

  useEffect(() => {
    mcpService.getOrchestratorInfo().then(setInfo).catch(() => {});
  }, []);

  if (!info || !info.port) return null;

  const url = `http://127.0.0.1:${info.port}/mcp?token=${info.token}`;

  function copyText(text: string, setter: (v: boolean) => void) {
    navigator.clipboard.writeText(text).then(() => {
      setter(true);
      setTimeout(() => setter(false), 1500);
    });
  }

  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Zap size={14} className="text-primary shrink-0" />
        <span className="text-xs font-medium">CC-Panes MCP (self)</span>
        <Badge variant="secondary" className="text-[10px]">HTTP</Badge>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground w-10 shrink-0">URL</span>
          <code className="flex-1 text-[10px] font-mono bg-muted rounded px-1.5 py-0.5 truncate">
            {url}
          </code>
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5 shrink-0"
            onClick={() => copyText(url, setCopiedUrl)}
            title={t("sharedMcp.copyUrl")}
          >
            {copiedUrl ? <Check size={10} className="text-[var(--app-status-success)]" /> : <Copy size={10} />}
          </Button>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground w-10 shrink-0">Token</span>
          <code className="flex-1 text-[10px] font-mono bg-muted rounded px-1.5 py-0.5 truncate">
            {info.token}
          </code>
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5 shrink-0"
            onClick={() => copyText(info.token, setCopiedToken)}
            title={t("sharedMcp.copyToken")}
          >
            {copiedToken ? <Check size={10} className="text-[var(--app-status-success)]" /> : <Copy size={10} />}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function SharedMcpSection() {
  const { t } = useTranslation(["settings", "common"]);
  const servers = useSharedMcpStore((s) => s.servers);
  const config = useSharedMcpStore((s) => s.config);
  const fetchStatus = useSharedMcpStore((s) => s.fetchStatus);
  const fetchConfig = useSharedMcpStore((s) => s.fetchConfig);
  const startServer = useSharedMcpStore((s) => s.startServer);
  const stopServer = useSharedMcpStore((s) => s.stopServer);
  const restartServer = useSharedMcpStore((s) => s.restartServer);
  const upsertServer = useSharedMcpStore((s) => s.upsertServer);
  const toggleShared = useSharedMcpStore((s) => s.toggleShared);
  const removeServer = useSharedMcpStore((s) => s.removeServer);
  const importFromClaude = useSharedMcpStore((s) => s.importFromClaude);

  const [importing, setImporting] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>({ ...emptyForm });
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    fetchStatus();
    fetchConfig();
  }, [fetchStatus, fetchConfig]);

  // 定时刷新状态
  useEffect(() => {
    const timer = setInterval(fetchStatus, 5000);
    return () => clearInterval(timer);
  }, [fetchStatus]);

  async function handleImport() {
    setImporting(true);
    try {
      const imported = await importFromClaude();
      if (imported.length > 0) {
        toast.success(t("sharedMcp.importedCount", { count: imported.length }));
      } else {
        toast.info(t("sharedMcp.noNewServers"));
      }
    } catch (e) {
      toast.error(t("sharedMcp.importFailed", { error: String(e) }));
    } finally {
      setImporting(false);
    }
  }

  function nextAvailablePort(currentName?: string): number {
    const rangeStart = config?.portRangeStart ?? 3100;
    const rangeEnd = config?.portRangeEnd ?? 3199;
    const used = new Set(
      servers
        .filter((server) => server.name !== currentName)
        .map((server) => server.config.port),
    );
    for (let port = rangeStart; port <= rangeEnd; port += 1) {
      if (!used.has(port)) return port;
    }
    return rangeStart;
  }

  function resetForm() {
    setEditing(false);
    setEditingName(null);
    setForm({ ...emptyForm });
  }

  function handleNew() {
    setEditingName(null);
    setForm({
      ...emptyForm,
      port: String(nextAvailablePort()),
    });
    setEditing(true);
  }

  function handleEdit(server: SharedMcpServerInfo) {
    setEditingName(server.name);
    setForm({
      name: server.name,
      command: server.config.command,
      args: server.config.args.join(" "),
      env: formatEnvLines(server.config.env),
      shared: server.config.shared,
      port: String(server.config.port),
      bridgeMode: server.config.bridgeMode,
    });
    setEditing(true);
  }

  async function handleSave() {
    const name = form.name.trim();
    const command = form.command.trim();
    const port = Number.parseInt(form.port, 10);

    if (!name || !command) {
      toast.error(t("sharedMcp.nameCommandRequired"));
      return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      toast.error(t("sharedMcp.portInvalid"));
      return;
    }

    const duplicate = servers.some((server) => server.name !== editingName && server.name === name);
    if (duplicate) {
      toast.error(t("sharedMcp.nameExists"));
      return;
    }
    const portDuplicate = servers.some((server) => server.name !== editingName && server.config.port === port);
    if (portDuplicate) {
      toast.error(t("sharedMcp.portInUse"));
      return;
    }

    const updated: SharedMcpServerConfig = {
      command,
      args: form.args.trim() ? form.args.trim().split(/\s+/) : [],
      env: parseEnvLines(form.env),
      shared: form.shared,
      port,
      bridgeMode: form.bridgeMode,
    };

    try {
      if (editingName && editingName !== name) {
        await removeServer(editingName);
      }
      await upsertServer(name, updated);
      toast.success(editingName ? t("sharedMcp.updated") : t("sharedMcp.added"));
      resetForm();
    } catch (e) {
      toast.error(t("common:saveFailed", { error: String(e) }));
    }
  }

  async function handleStart(name: string) {
    try {
      await startServer(name);
      toast.success(t("sharedMcp.started", { name }));
    } catch (e) {
      toast.error(t("sharedMcp.startFailed", { name, error: String(e) }));
    }
  }

  async function handleStop(name: string) {
    try {
      await stopServer(name);
      toast.success(t("sharedMcp.stopped", { name }));
    } catch (e) {
      toast.error(t("sharedMcp.stopFailed", { name, error: String(e) }));
    }
  }

  async function handleRestart(name: string) {
    try {
      await restartServer(name);
      toast.success(t("sharedMcp.restarted", { name }));
    } catch (e) {
      toast.error(t("sharedMcp.restartFailed", { name, error: String(e) }));
    }
  }

  async function handleToggleShared(name: string, enabled: boolean) {
    try {
      await toggleShared(name, enabled);
    } catch (e) {
      toast.error(t("sharedMcp.toggleFailed", { error: String(e) }));
    }
  }

  async function handleRemove(name: string) {
    try {
      await removeServer(name);
      toast.success(t("sharedMcp.removed", { name }));
      if (editingName === name) resetForm();
    } catch (e) {
      toast.error(t("sharedMcp.removeFailed", { error: String(e) }));
    }
  }

  const runningCount = servers.filter(
    (s) => s.status === "Running",
  ).length;

  return (
    <div className="space-y-4">
      {/* CC-Panes 自身 MCP 配置 */}
      <CcpanesMcpCard />

      {/* 标题 + 操作 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">{t("sharedMcp.title")}</h3>
          <Badge variant="secondary" className="text-xs">
            {runningCount}/{servers.length}
          </Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={handleNew}>
            <Plus size={14} className="mr-1" />
            {t("sharedMcp.add")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleImport}
            disabled={importing}
          >
            {importing ? (
              <Loader2 size={14} className="mr-1 animate-spin" />
            ) : (
              <Download size={14} className="mr-1" />
            )}
            {t("sharedMcp.importConfig")}
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {t("sharedMcp.importHint")}
      </p>

      {editing && (
        <div className="rounded-lg border-2 border-primary/30 bg-card p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-sm font-medium">
              {editingName ? t("sharedMcp.editTitle") : t("sharedMcp.newTitle")}
            </h4>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={resetForm}>
              <X size={14} />
            </Button>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">{t("sharedMcp.fieldName")}</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="context7"
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t("sharedMcp.fieldCommand")}</Label>
              <Input
                value={form.command}
                onChange={(e) => setForm({ ...form, command: e.target.value })}
                placeholder="npx"
                className="h-8 text-sm font-mono"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t("sharedMcp.fieldArgs")}</Label>
              <Input
                value={form.args}
                onChange={(e) => setForm({ ...form, args: e.target.value })}
                placeholder="-y @upstash/context7-mcp"
                className="h-8 text-sm font-mono"
              />
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
              <div className="space-y-1">
                <Label className="text-xs">{t("sharedMcp.fieldPort")}</Label>
                <Input
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: e.target.value })}
                  placeholder="3100"
                  className="h-8 text-sm font-mono"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t("sharedMcp.fieldBridge")}</Label>
                <select
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={form.bridgeMode}
                  onChange={(e) => setForm({ ...form, bridgeMode: e.target.value as BridgeMode })}
                >
                  <option value="mcp-proxy">mcp-proxy</option>
                  <option value="native-http">native-http</option>
                </select>
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">{t("sharedMcp.fieldEnv")}</Label>
            <textarea
              value={form.env}
              onChange={(e) => setForm({ ...form, env: e.target.value })}
              placeholder="KEY=VALUE"
              className="h-20 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.shared}
                onChange={(e) => setForm({ ...form, shared: e.target.checked })}
              />
              {t("sharedMcp.enableShared")}
            </label>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={resetForm}>
                <X size={14} className="mr-1" />
                {t("common:cancel")}
              </Button>
              <Button size="sm" onClick={handleSave}>
                <Save size={14} className="mr-1" />
                {t("common:save")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 服务器列表 */}
      {servers.length === 0 && !editing ? (
        <div className="text-center py-12 text-muted-foreground">
          <ServerOff size={28} className="mx-auto mb-3 opacity-40" />
          <p className="text-xs">{t("sharedMcp.emptyTitle")}</p>
          <p className="text-xs mt-1">
            {t("sharedMcp.emptyHint")}
          </p>
        </div>
      ) : servers.length > 0 ? (
        <div className="space-y-2">
          {servers.map((server) => (
            <ServerRow
              key={server.name}
              server={server}
              onStart={handleStart}
              onStop={handleStop}
              onRestart={handleRestart}
              onToggleShared={handleToggleShared}
              onRemove={handleRemove}
              onEdit={handleEdit}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ServerRow({
  server,
  onStart,
  onStop,
  onRestart,
  onToggleShared,
  onRemove,
  onEdit,
}: {
  server: SharedMcpServerInfo;
  onStart: (name: string) => void;
  onStop: (name: string) => void;
  onRestart: (name: string) => void;
  onToggleShared: (name: string, enabled: boolean) => void;
  onRemove: (name: string) => void;
  onEdit: (server: SharedMcpServerInfo) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const isRunning = server.status === "Running";
  const isStopped = server.status === "Stopped";
  // Failed（含超过重启上限的熔断态）必须给 Restart 入口：后端 restart 会
  // 重建 runtime 并清零重启计数，是解除熔断的唯一 UI 路径。
  const isFailed = typeof server.status === "object" && "Failed" in server.status;

  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card">
      {/* 共享开关 */}
      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7 shrink-0"
        onClick={() => onToggleShared(server.name, !server.config.shared)}
        title={server.config.shared ? t("sharedMcp.disableSharing") : t("sharedMcp.enableSharing")}
      >
        {server.config.shared ? (
          <ToggleRight size={18} className="text-primary" />
        ) : (
          <ToggleLeft size={18} className="text-muted-foreground" />
        )}
      </Button>

      {/* 信息 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">
            {server.name}
          </span>
          <Badge variant={statusVariant(server.status)} className="text-[10px]">
            {statusLabel(server.status)}
          </Badge>
          <span className="text-[10px] text-muted-foreground">
            :{server.config.port}
          </span>
        </div>
        <div className="text-xs text-muted-foreground font-mono truncate">
          {server.config.command} {server.config.args.join(" ")}
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="flex items-center gap-1">
        {isStopped && server.config.shared && (
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={() => onStart(server.name)}
            title={t("sharedMcp.start")}
          >
            <Play size={13} />
          </Button>
        )}
        {isFailed && (
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={() => onRestart(server.name)}
            title={t("sharedMcp.restart")}
          >
            <RotateCw size={13} />
          </Button>
        )}
        {isRunning && (
          <>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => onRestart(server.name)}
              title={t("sharedMcp.restart")}
            >
              <RotateCw size={13} />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => onStop(server.name)}
              title={t("sharedMcp.stop")}
            >
              <Square size={13} />
            </Button>
          </>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => onEdit(server)}
          title={t("sharedMcp.edit")}
        >
          <SquarePen size={13} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-destructive"
          onClick={() => onRemove(server.name)}
          title={t("sharedMcp.remove")}
        >
          <Trash2 size={13} />
        </Button>
      </div>
    </div>
  );
}

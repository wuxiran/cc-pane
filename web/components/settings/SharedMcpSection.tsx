import { useState, useEffect } from "react";
import { toast } from "sonner";
import {
  ServerOff,
  Play,
  Square,
  RotateCw,
  Trash2,
  Download,
  Loader2,
  ToggleLeft,
  ToggleRight,
  Copy,
  Check,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useSharedMcpStore } from "@/stores";
import type { SharedMcpServerInfo, SharedMcpServerStatus } from "@/types";
import { mcpService } from "@/services";

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
            title="Copy URL"
          >
            {copiedUrl ? <Check size={10} className="text-green-500" /> : <Copy size={10} />}
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
            title="Copy token"
          >
            {copiedToken ? <Check size={10} className="text-green-500" /> : <Copy size={10} />}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function SharedMcpSection() {
  const servers = useSharedMcpStore((s) => s.servers);
  const fetchStatus = useSharedMcpStore((s) => s.fetchStatus);
  const fetchConfig = useSharedMcpStore((s) => s.fetchConfig);
  const startServer = useSharedMcpStore((s) => s.startServer);
  const stopServer = useSharedMcpStore((s) => s.stopServer);
  const restartServer = useSharedMcpStore((s) => s.restartServer);
  const toggleShared = useSharedMcpStore((s) => s.toggleShared);
  const removeServer = useSharedMcpStore((s) => s.removeServer);
  const importFromClaude = useSharedMcpStore((s) => s.importFromClaude);

  const [importing, setImporting] = useState(false);

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
        toast.success(`Imported ${imported.length} MCP servers`);
      } else {
        toast.info("No new servers to import");
      }
    } catch (e) {
      toast.error(`Import failed: ${String(e)}`);
    } finally {
      setImporting(false);
    }
  }

  async function handleStart(name: string) {
    try {
      await startServer(name);
      toast.success(`Started ${name}`);
    } catch (e) {
      toast.error(`Failed to start ${name}: ${String(e)}`);
    }
  }

  async function handleStop(name: string) {
    try {
      await stopServer(name);
      toast.success(`Stopped ${name}`);
    } catch (e) {
      toast.error(`Failed to stop ${name}: ${String(e)}`);
    }
  }

  async function handleRestart(name: string) {
    try {
      await restartServer(name);
      toast.success(`Restarted ${name}`);
    } catch (e) {
      toast.error(`Failed to restart ${name}: ${String(e)}`);
    }
  }

  async function handleToggleShared(name: string, enabled: boolean) {
    try {
      await toggleShared(name, enabled);
    } catch (e) {
      toast.error(`Toggle failed: ${String(e)}`);
    }
  }

  async function handleRemove(name: string) {
    try {
      await removeServer(name);
      toast.success(`Removed ${name}`);
    } catch (e) {
      toast.error(`Remove failed: ${String(e)}`);
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
          <h3 className="text-sm font-medium">Shared MCP Servers</h3>
          <Badge variant="secondary" className="text-xs">
            {runningCount}/{servers.length}
          </Badge>
        </div>
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
          Import from .claude.json
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Share stateless MCP servers across Claude instances via HTTP, reducing
        process count by ~60%.
      </p>

      {/* 服务器列表 */}
      {servers.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <ServerOff size={28} className="mx-auto mb-3 opacity-40" />
          <p className="text-xs">No shared MCP servers configured</p>
          <p className="text-xs mt-1">
            Click &quot;Import from .claude.json&quot; to get started
          </p>
        </div>
      ) : (
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
            />
          ))}
        </div>
      )}
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
}: {
  server: SharedMcpServerInfo;
  onStart: (name: string) => void;
  onStop: (name: string) => void;
  onRestart: (name: string) => void;
  onToggleShared: (name: string, enabled: boolean) => void;
  onRemove: (name: string) => void;
}) {
  const isRunning = server.status === "Running";
  const isStopped = server.status === "Stopped";

  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card">
      {/* 共享开关 */}
      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7 shrink-0"
        onClick={() => onToggleShared(server.name, !server.config.shared)}
        title={server.config.shared ? "Disable sharing" : "Enable sharing"}
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
            title="Start"
          >
            <Play size={13} />
          </Button>
        )}
        {isRunning && (
          <>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => onRestart(server.name)}
              title="Restart"
            >
              <RotateCw size={13} />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => onStop(server.name)}
              title="Stop"
            >
              <Square size={13} />
            </Button>
          </>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-destructive"
          onClick={() => onRemove(server.name)}
          title="Remove"
        >
          <Trash2 size={13} />
        </Button>
      </div>
    </div>
  );
}

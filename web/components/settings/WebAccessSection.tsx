import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ExternalLink, RefreshCw, RotateCcw, ShieldCheck, Square, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { mcpService, settingsService } from "@/services";
import { isTauriRuntime } from "@/services/runtime";
import { useSettingsStore } from "@/stores";
import type {
  OrchestratorBindMode,
  OrchestratorSettings,
  OrchestratorStatus,
  WebAccessSettings,
  WebAccessStatus,
} from "@/types";

interface WebAccessSectionProps {
  value: WebAccessSettings;
  onChange: (value: WebAccessSettings) => void;
  orchestrator?: OrchestratorSettings;
  onOrchestratorChange?: (value: OrchestratorSettings) => void;
}

const ORCHESTRATOR_BIND_MODES: Array<{ mode: OrchestratorBindMode; label: string; hint: string }> = [
  {
    mode: "auto",
    label: "自动（推荐）",
    hint: "默认仅本机；WSL mirrored 网络下回环即可被 WSL 访问，仅 NAT 模式的 WSL 使用会开放所有网卡。",
  },
  {
    mode: "loopback",
    label: "仅本机",
    hint: "始终 127.0.0.1。WSL mirrored 网络下 WSL 仍可访问；NAT 模式下 WSL 内 CLI 可能无法回连 MCP。",
  },
  { mode: "all", label: "所有网卡", hint: "始终 0.0.0.0（局域网可见，凭随机端口 + token 防护）。" },
];

function normalizeWhitelistText(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export default function WebAccessSection({
  value,
  onChange,
  orchestrator,
  onOrchestratorChange,
}: WebAccessSectionProps) {
  const [status, setStatus] = useState<WebAccessStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [orchestratorStatus, setOrchestratorStatus] = useState<OrchestratorStatus | null>(null);
  const [password, setPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const loadSettings = useSettingsStore((state) => state.loadSettings);
  const currentSettings = useSettingsStore((state) => state.settings);
  const passwordConfigured = Boolean(value.passwordHash || currentSettings?.webAccess.passwordHash);
  const canUseLan = value.authEnabled && passwordConfigured;

  const whitelistText = useMemo(() => value.ipWhitelist.join("\n"), [value.ipWhitelist]);

  function update<K extends keyof WebAccessSettings>(key: K, next: WebAccessSettings[K]) {
    onChange({ ...value, [key]: next });
  }

  async function refreshStatus() {
    setLoadingStatus(true);
    try {
      setStatus(await settingsService.getWebAccessStatus());
    } catch (error) {
      toast.error(`Web 状态读取失败: ${error}`);
    } finally {
      setLoadingStatus(false);
    }
  }

  useEffect(() => {
    void refreshStatus();
    void mcpService
      .getOrchestratorStatus()
      .then(setOrchestratorStatus)
      .catch(() => setOrchestratorStatus(null));
  }, []);

  async function handleSetPassword() {
    setSavingPassword(true);
    try {
      await settingsService.setWebAccessPassword(password);
      setPassword("");
      await loadSettings();
      await refreshStatus();
      toast.success(password.trim() ? "Web 密码已更新" : "Web 密码已清空");
    } catch (error) {
      toast.error(`Web 密码更新失败: ${error}`);
    } finally {
      setSavingPassword(false);
    }
  }

  async function handleAction(action: "start" | "stop" | "restart" | "open") {
    try {
      if (action === "start") setStatus(await settingsService.startWebAccess());
      if (action === "stop") setStatus(await settingsService.stopWebAccess());
      if (action === "restart") setStatus(await settingsService.restartWebAccess());
      if (action === "open") await settingsService.openWebAccess();
    } catch (error) {
      toast.error(`Web 服务操作失败: ${error}`);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-[15px] font-semibold mb-1" style={{ color: "var(--app-text-primary)" }}>
          Web 访问
        </h3>
        <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
          启动本机 Web 端，使用同一套 CC-Panes 数据。局域网访问必须先配置账号密码。
        </p>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <Label>启动时启用 Web 端</Label>
          <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
            关闭后桌面端启动时不会拉起 Web 服务。
          </p>
        </div>
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(event) => update("enabled", event.target.checked)}
          className="w-4 h-4 cursor-pointer"
          style={{ accentColor: "var(--app-accent)" }}
        />
      </div>

      <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
        <div className="flex flex-col gap-1">
          <Label>端口</Label>
          <Input
            type="number"
            min={1}
            max={65535}
            value={value.port}
            onChange={(event) => update("port", Number(event.target.value))}
          />
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => update("port", 18080)}
        >
          <RotateCcw className="w-3.5 h-3.5 mr-1" />
          重置
        </Button>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <Label>启动后自动打开浏览器</Label>
          <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
            适合把 Web 端作为默认入口的场景。
          </p>
        </div>
        <input
          type="checkbox"
          checked={value.autoOpen}
          onChange={(event) => update("autoOpen", event.target.checked)}
          className="w-4 h-4 cursor-pointer"
          style={{ accentColor: "var(--app-accent)" }}
        />
      </div>

      <div className="flex flex-col gap-3 pt-3" style={{ borderTop: "1px solid var(--app-border)" }}>
        <div className="flex items-center justify-between">
          <div>
            <Label>账号密码登录</Label>
            <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
              启用后 Web 端 API 和终端 WebSocket 都需要登录 session。
            </p>
          </div>
          <input
            type="checkbox"
            checked={value.authEnabled}
            onChange={(event) => update("authEnabled", event.target.checked)}
            className="w-4 h-4 cursor-pointer"
            style={{ accentColor: "var(--app-accent)" }}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <Label>账号</Label>
            <Input value={value.username} onChange={(event) => update("username", event.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label>空闲锁屏</Label>
            <Input
              type="number"
              min={0}
              max={1440}
              value={value.lockOnIdleMinutes}
              onChange={(event) => update("lockOnIdleMinutes", Number(event.target.value))}
            />
          </div>
        </div>

        <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
          <div className="flex flex-col gap-1">
            <Label>{passwordConfigured ? "更新密码" : "设置密码"}</Label>
            <Input
              type="password"
              value={password}
              placeholder={passwordConfigured ? "留空并点击保存可清空密码" : "请输入 Web 登录密码"}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <Button type="button" size="sm" onClick={handleSetPassword} disabled={savingPassword}>
            <ShieldCheck className="w-3.5 h-3.5 mr-1" />
            保存密码
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 pt-3" style={{ borderTop: "1px solid var(--app-border)" }}>
        <div className="flex items-center justify-between">
          <div>
            <Label>允许局域网访问</Label>
            <p className="text-xs m-0" style={{ color: canUseLan ? "var(--app-text-tertiary)" : "var(--app-accent)" }}>
              {canUseLan ? "开启后服务会监听 0.0.0.0。" : "需要先启用账号密码并设置密码。"}
            </p>
          </div>
          <input
            type="checkbox"
            checked={value.allowLan}
            disabled={!canUseLan}
            onChange={(event) => update("allowLan", event.target.checked)}
            className="w-4 h-4 cursor-pointer"
            style={{ accentColor: "var(--app-accent)" }}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label>远程只读模式</Label>
            <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
              非本机来源（含经 Tailscale Serve 访问）登录后只能查看，禁止终端输入与文件改动；本机浏览器不受影响。保存后重启 Web 服务生效。
            </p>
          </div>
          <input
            type="checkbox"
            checked={value.remoteReadOnly}
            onChange={(event) => update("remoteReadOnly", event.target.checked)}
            className="w-4 h-4 cursor-pointer"
            style={{ accentColor: "var(--app-accent)" }}
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label>IP 白名单</Label>
          <textarea
            value={whitelistText}
            onChange={(event) => update("ipWhitelist", normalizeWhitelistText(event.target.value))}
            rows={3}
            className="px-2 py-1.5 rounded-md text-[13px] outline-none font-mono resize-none"
            placeholder="192.168.1.20"
            style={{
              border: "1px solid var(--app-border)",
              background: "var(--app-content)",
              color: "var(--app-text-primary)",
            }}
          />
          <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
            留空表示允许任意局域网客户端；多条用换行或逗号分隔。
          </p>
        </div>
      </div>

      {orchestrator && onOrchestratorChange && isTauriRuntime() && (
        <div className="flex flex-col gap-2 pt-3" style={{ borderTop: "1px solid var(--app-border)" }}>
          <div>
            <Label>MCP 编排服务监听</Label>
            <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
              CC-Panes 内置 orchestrator（供 CLI 的 ccpanes MCP 工具回连）。修改后重启应用生效。
            </p>
          </div>
          <select
            value={orchestrator.bindMode}
            onChange={(event) =>
              onOrchestratorChange({ ...orchestrator, bindMode: event.target.value as OrchestratorBindMode })
            }
            className="px-2 py-1.5 rounded-md text-[13px] outline-none cursor-pointer"
            style={{
              border: "1px solid var(--app-border)",
              background: "var(--app-content)",
              color: "var(--app-text-primary)",
            }}
          >
            {ORCHESTRATOR_BIND_MODES.map((item) => (
              <option key={item.mode} value={item.mode}>
                {item.label}
              </option>
            ))}
          </select>
          <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
            {ORCHESTRATOR_BIND_MODES.find((item) => item.mode === orchestrator.bindMode)?.hint}
          </p>
          {orchestratorStatus?.bind && (
            <p className="text-xs m-0" style={{ color: "var(--app-text-secondary)" }}>
              当前实际监听 {orchestratorStatus.bind.host}
              {orchestratorStatus.port != null ? `:${orchestratorStatus.port}` : ""}（{orchestratorStatus.bind.reason}）
            </p>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2 pt-3" style={{ borderTop: "1px solid var(--app-border)" }}>
        <div className="flex items-center justify-between">
          <div className="text-xs" style={{ color: "var(--app-text-secondary)" }}>
            {status
              ? `${status.running ? "运行中" : "未运行"} · ${status.url} · ${status.bindHost}:${status.port}`
              : "状态未读取"}
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={refreshStatus} disabled={loadingStatus}>
            <RefreshCw className={`w-3.5 h-3.5 ${loadingStatus ? "animate-spin" : ""}`} />
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={() => void handleAction("open")}>
            <ExternalLink className="w-3.5 h-3.5 mr-1" />
            打开 Web
          </Button>
          {isTauriRuntime() && (
            <>
              <Button type="button" variant="secondary" size="sm" onClick={() => void handleAction("start")}>
                <Wifi className="w-3.5 h-3.5 mr-1" />
                启动
              </Button>
              <Button type="button" variant="secondary" size="sm" onClick={() => void handleAction("restart")}>
                <RefreshCw className="w-3.5 h-3.5 mr-1" />
                重启
              </Button>
              <Button type="button" variant="secondary" size="sm" onClick={() => void handleAction("stop")}>
                <Square className="w-3.5 h-3.5 mr-1" />
                停止
              </Button>
            </>
          )}
        </div>
        <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
          端口、局域网访问和密码策略保存后，重启 Web 服务生效。
        </p>
      </div>
    </div>
  );
}

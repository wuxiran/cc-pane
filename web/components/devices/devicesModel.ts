// 设备视图的纯逻辑（便于测试）。docs/111-multi-device.md
import type {
  DeviceCliTool,
  DeviceLaunchRecord,
  DeviceSessionStatus,
  DeviceSnapshot,
  DeviceSummary,
} from "@/types/device";

export type DeviceStatus =
  | "unknown" //  还没拉过快照
  | "online"
  | "sshFailed" // SSH 都连不上
  | "notRunning" // SSH 通了，服务没在跑（多半没部署）
  | "unauthorized" // 令牌无效 / 没令牌
  | "error";

export function deviceStatus(snapshot: DeviceSnapshot | undefined): DeviceStatus {
  if (!snapshot) return "unknown";
  if (snapshot.online) return "online";
  switch (snapshot.errorKind) {
    case "ssh":
      return "sshFailed";
    case "unreachable":
      return "notRunning";
    case "unauthorized":
      return "unauthorized";
    default:
      return "error";
  }
}

/** 需要（重新）部署才能用的状态：SSH 设备在这些状态下显示「部署」按钮。 */
export function needsDeploy(device: DeviceSummary, status: DeviceStatus): boolean {
  if (device.connection.kind !== "ssh") return false;
  return status === "notRunning" || status === "unauthorized" || (status === "online" && !device.hasToken);
}

/** 远端版本与本机不一致时提示升级（只比较主版本号三段）。 */
export function versionMismatch(remote: string | null | undefined, local: string | null | undefined): boolean {
  if (!remote || !local) return false;
  const core = (value: string) => value.trim().replace(/^v/, "").split(/[-+]/)[0];
  return core(remote) !== core(local);
}

/** 关注的 CLI：claude / codex 总显示（装没装都要看到），其他只显示已安装的。 */
const PRIMARY_CLIS = ["claude", "codex"];

export function visibleCliTools(tools: DeviceCliTool[] | undefined): DeviceCliTool[] {
  if (!tools) return [];
  const primary = PRIMARY_CLIS.map((id) => tools.find((tool) => tool.id === id)).filter(
    (tool): tool is DeviceCliTool => Boolean(tool),
  );
  const others = tools.filter((tool) => !PRIMARY_CLIS.includes(tool.id) && tool.installed);
  return [...primary, ...others];
}

/** `2.1.319 (Claude Code)` → `2.1.319`；`codex-cli 0.166.0` → `0.166.0` */
export function shortVersion(version: string | null | undefined): string | null {
  if (!version) return null;
  const match = version.match(/\d+\.\d+(?:\.\d+)?/);
  return match ? match[0] : version.trim().slice(0, 16);
}

export interface DeviceSessionRow {
  sessionId: string;
  status: string;
  lastOutputAt: number;
  projectName: string | null;
  projectPath: string | null;
  cliTool: string | null;
  lastPrompt: string | null;
}

/** 把运行中的会话和最近启动记录按 ptySessionId 对上，拿到项目和 CLI。 */
export function joinSessions(
  sessions: DeviceSessionStatus[] | null | undefined,
  launches: DeviceLaunchRecord[] | null | undefined,
): DeviceSessionRow[] {
  const byPty = new Map<string, DeviceLaunchRecord>();
  for (const launch of launches ?? []) {
    if (launch.ptySessionId && !byPty.has(launch.ptySessionId)) byPty.set(launch.ptySessionId, launch);
  }
  return (sessions ?? [])
    .filter((session) => session.status !== "exited")
    .map((session) => {
      const launch = byPty.get(session.sessionId);
      return {
        sessionId: session.sessionId,
        status: session.status,
        lastOutputAt: session.lastOutputAt,
        projectName: launch?.projectName ?? null,
        projectPath: launch?.projectPath ?? null,
        cliTool: launch?.cliTool ?? null,
        lastPrompt: launch?.lastPrompt ?? null,
      };
    })
    .sort((a, b) => b.lastOutputAt - a.lastOutputAt);
}

/**
 * 明文 HTTP 且不是回环 / Tailscale 地址：令牌和终端内容会以明文经过网络。
 * Tailscale 的 100.64.0.0/10 地址和 *.ts.net 域名本身走 WireGuard 加密。
 */
export function isInsecureRemoteUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host.startsWith("127.")) return false;
  if (host.endsWith(".ts.net")) return false;
  const octets = host.split(".").map(Number);
  if (octets.length === 4 && octets.every((part) => Number.isInteger(part))) {
    const [a, b] = octets;
    if (a === 100 && b >= 64 && b <= 127) return false;
  }
  return true;
}

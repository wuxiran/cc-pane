import { describe, expect, it } from "vitest";
import type { DeviceSnapshot, DeviceSummary } from "@/types/device";
import {
  deviceStatus,
  isInsecureRemoteUrl,
  joinSessions,
  needsDeploy,
  shortVersion,
  versionMismatch,
  visibleCliTools,
} from "./devicesModel";

const sshDevice: DeviceSummary = {
  id: "d1",
  name: "box",
  connection: { kind: "ssh", machineId: "m1", remotePort: 18765 },
  createdAt: "",
  hasToken: true,
  targetLabel: "dev@box",
};

function snapshot(partial: Partial<DeviceSnapshot>): DeviceSnapshot {
  return {
    deviceId: "d1",
    online: false,
    errorKind: null,
    error: null,
    info: null,
    environment: null,
    workspaces: null,
    sessions: null,
    launches: null,
    ...partial,
  };
}

describe("devicesModel", () => {
  it("maps snapshot errors to statuses", () => {
    expect(deviceStatus(undefined)).toBe("unknown");
    expect(deviceStatus(snapshot({ online: true }))).toBe("online");
    expect(deviceStatus(snapshot({ errorKind: "ssh" }))).toBe("sshFailed");
    expect(deviceStatus(snapshot({ errorKind: "unreachable" }))).toBe("notRunning");
    expect(deviceStatus(snapshot({ errorKind: "unauthorized" }))).toBe("unauthorized");
  });

  it("offers deploy only for SSH devices that are not usable yet", () => {
    expect(needsDeploy(sshDevice, "notRunning")).toBe(true);
    expect(needsDeploy(sshDevice, "unauthorized")).toBe(true);
    expect(needsDeploy(sshDevice, "online")).toBe(false);
    expect(needsDeploy(sshDevice, "sshFailed")).toBe(false);
    expect(needsDeploy({ ...sshDevice, connection: { kind: "direct", baseUrl: "http://x" } }, "notRunning")).toBe(false);
  });

  it("compares versions ignoring prefix and suffix", () => {
    expect(versionMismatch("0.12.21", "v0.12.21")).toBe(false);
    expect(versionMismatch("0.12.21-dev", "0.12.21")).toBe(false);
    expect(versionMismatch("0.12.20", "0.12.21")).toBe(true);
    expect(versionMismatch(null, "0.12.21")).toBe(false);
  });

  it("always shows claude and codex, other CLIs only when installed", () => {
    const tools = visibleCliTools([
      { id: "gemini", installed: true, version: "0.1.9" },
      { id: "kimi", installed: false, version: null },
      { id: "codex", installed: false, version: null },
      { id: "claude", installed: true, version: "2.1.319 (Claude Code)" },
    ]);
    expect(tools.map((tool) => tool.id)).toEqual(["claude", "codex", "gemini"]);
    expect(shortVersion("2.1.319 (Claude Code)")).toBe("2.1.319");
    expect(shortVersion("codex-cli 0.166.0")).toBe("0.166.0");
  });

  it("joins live sessions to their launch records and hides exited ones", () => {
    const rows = joinSessions(
      [
        { sessionId: "a", status: "idle", lastOutputAt: 1 },
        { sessionId: "b", status: "thinking", lastOutputAt: 5 },
        { sessionId: "c", status: "exited", lastOutputAt: 9 },
      ],
      [
        { ptySessionId: "b", projectName: "api", projectPath: "/srv/api", cliTool: "claude", launchedAt: "", workspaceName: null, lastPrompt: null },
        { ptySessionId: "b", projectName: "older", projectPath: "/x", cliTool: "codex", launchedAt: "", workspaceName: null, lastPrompt: null },
      ],
    );
    expect(rows.map((row) => [row.sessionId, row.projectName, row.cliTool])).toEqual([
      ["b", "api", "claude"],
      ["a", null, null],
    ]);
  });

  it("flags plain HTTP outside loopback and Tailscale", () => {
    expect(isInsecureRemoteUrl("http://192.168.1.20:8080")).toBe(true);
    expect(isInsecureRemoteUrl("http://100.101.5.6:8080")).toBe(false);
    expect(isInsecureRemoteUrl("http://studio.tail1234.ts.net:8080")).toBe(false);
    expect(isInsecureRemoteUrl("http://127.0.0.1:8080")).toBe(false);
    expect(isInsecureRemoteUrl("https://example.com")).toBe(false);
  });
});

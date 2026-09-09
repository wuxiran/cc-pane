import { describe, expect, it } from "vitest";
import type { LaunchProfile } from "@/types";
import type { SharedMcpServerInfo } from "@/types/shared-mcp";
import { defaultLaunchProfileDraft } from "@/types/launch-profile";
import {
  buildMcpHubEntries,
  commandLine,
  filterMcpHubEntries,
  injectedCount,
  sharedStatusKey,
} from "./mcpHubModel";

const profile: LaunchProfile = {
  id: "p",
  createdAt: "",
  updatedAt: "",
  ...defaultLaunchProfileDraft(),
  name: "Default",
  isDefault: true,
};

const shared = (name: string, status: SharedMcpServerInfo["status"] = "running"): SharedMcpServerInfo => ({
  name,
  config: { command: "npx", args: ["-y", name], env: {}, shared: true, port: 3100, bridgeMode: "mcp-proxy" },
  status,
  pid: null,
  url: null,
  restartCount: 0,
});

describe("mcpHubModel", () => {
  it("有启动档时先列内置 + 共享，再列本层（按名排序）", () => {
    const entries = buildMcpHubEntries({
      profile,
      sharedServers: [shared("fetch")],
      layerServers: { zeta: { command: "z", args: [], env: {} }, alpha: { command: "a", args: [], env: {} } },
      layer: "workspace",
    });
    expect(entries.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
      "ccpanes:CC-Panes MCP",
      "shared:fetch",
      "layer:alpha",
      "layer:zeta",
    ]);
    expect(injectedCount(entries)).toBe(2);
  });

  it("启动档关闭 MCP 时全部不注入且不可切换；没有启动档就只剩本层", () => {
    const off = { ...profile, mcpPolicy: { ...profile.mcpPolicy, mode: "disabled" as const } };
    const entries = buildMcpHubEntries({ profile: off, sharedServers: [shared("fetch")], layerServers: {}, layer: "project" });
    expect(entries.every((entry) => entry.kind === "layer" || (!entry.enabled && !entry.canToggle))).toBe(true);
    expect(injectedCount(entries)).toBe(0);

    const none = buildMcpHubEntries({ profile: null, sharedServers: [shared("fetch")], layerServers: { a: { command: "a", args: [], env: {} } }, layer: "project" });
    expect(none.map((entry) => entry.kind)).toEqual(["layer"]);
  });

  it("共享服务被启动档排除时 enabled=false 但仍可切回", () => {
    const excluded = { ...profile, mcpPolicy: { ...profile.mcpPolicy, disabledServerIds: ["fetch"] } };
    const [, fetch] = buildMcpHubEntries({ profile: excluded, sharedServers: [shared("fetch")], layerServers: {}, layer: "workspace" });
    expect(fetch.kind === "shared" && fetch.enabled).toBe(false);
    expect(fetch.kind === "shared" && fetch.canToggle).toBe(true);
  });

  it("筛选与状态、命令行辅助", () => {
    const entries = buildMcpHubEntries({ profile, sharedServers: [shared("fetch", { failed: { message: "boom" } })], layerServers: { a: { command: "a", args: ["--x"], env: {} } }, layer: "workspace" });
    expect(filterMcpHubEntries(entries, "profile")).toHaveLength(2);
    expect(filterMcpHubEntries(entries, "layer")).toHaveLength(1);
    expect(sharedStatusKey("running")).toBe("running");
    expect(sharedStatusKey({ failed: { message: "boom" } })).toBe("failed");
    expect(commandLine({ command: "a", args: ["--x"] })).toBe("a --x");
  });
});

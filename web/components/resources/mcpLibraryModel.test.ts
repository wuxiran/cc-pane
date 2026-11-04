import { describe, expect, it } from "vitest";
import type { LaunchProfile, McpServerConfig, SharedMcpServerInfo } from "@/types";
import { buildMcpLibraryEntries, filterMcpLibraryEntries } from "./mcpLibraryModel";
import { mcpChipState } from "./resourceCenterModel";

const config = (command: string): McpServerConfig => ({ command, args: [], env: {} });
const shared = (name: string) =>
  ({ name, status: "stopped", config: { command: "npx", args: [name], env: {}, shared: true, port: 3100, bridgeMode: "mcp-proxy" } }) as unknown as SharedMcpServerInfo;
const policy = (patch: Partial<LaunchProfile["mcpPolicy"]>) =>
  ({ mode: "default", includeCcpanesMcp: true, includeSharedMcp: true, enabledServerIds: [], disabledServerIds: [], ...patch }) as LaunchProfile["mcpPolicy"];

describe("buildMcpLibraryEntries", () => {
  it("按内置、共享、项目、工作空间排列", () => {
    const entries = buildMcpLibraryEntries({
      sharedServers: [shared("b"), shared("a")],
      workspace: { target: { workspaceName: "w" }, servers: { w1: config("x") } },
      project: { target: { projectPath: "/p" }, servers: { p1: config("y") } },
    });
    expect(entries.map((entry) => entry.key)).toEqual(["ccpanes", "shared:a", "shared:b", "project:p1", "workspace:w1"]);
  });

  it("同名时只标记工作空间那条被项目覆盖", () => {
    const entries = buildMcpLibraryEntries({
      sharedServers: [],
      workspace: { target: { workspaceName: "w" }, servers: { same: config("x") } },
      project: { target: { projectPath: "/p" }, servers: { same: config("y") } },
    });
    const layers = entries.filter((entry) => entry.kind === "layer");
    expect(layers.map((entry) => [entry.key, entry.kind === "layer" && entry.shadowed])).toEqual([
      ["project:same", false],
      ["workspace:same", true],
    ]);
  });
});

describe("filterMcpLibraryEntries", () => {
  it("同时搜索名称和命令", () => {
    const entries = buildMcpLibraryEntries({ sharedServers: [shared("alpha")] });
    expect(filterMcpLibraryEntries(entries, "ALPHA").map((entry) => entry.name)).toEqual(["alpha"]);
    expect(filterMcpLibraryEntries(entries, "npx").map((entry) => entry.name)).toEqual(["alpha"]);
    expect(filterMcpLibraryEntries(entries, " ")).toHaveLength(2);
  });
});

describe("mcpChipState 层配置与后端过滤规则一致", () => {
  const layer = { kind: "layer", name: "x" } as const;

  it("默认模式下除非列入禁用，否则开启，且不受共享开关影响", () => {
    expect(mcpChipState(policy({ includeSharedMcp: false }), layer)).toEqual({ on: true, blocked: null });
    expect(mcpChipState(policy({ disabledServerIds: ["x"] }), layer)).toEqual({ on: false, blocked: null });
  });

  it("自定义模式下只有明确选中才开启", () => {
    expect(mcpChipState(policy({ mode: "custom" }), layer)).toEqual({ on: false, blocked: null });
    expect(mcpChipState(policy({ mode: "custom", enabledServerIds: ["x"] }), layer)).toEqual({ on: true, blocked: null });
  });

  it("MCP 关闭时不可切换", () => {
    expect(mcpChipState(policy({ mode: "disabled" }), layer)).toEqual({ on: false, blocked: "mcpDisabled" });
  });
});

import { describe, expect, it } from "vitest";
import type { McpMarketInput, McpMarketServer, SharedMcpServerInfo } from "@/types/shared-mcp";
import { buildSharedConfig, installedServer, marketDescription, marketReachSource, missingRequiredInput, needsInputSheet, serverIdentity } from "./mcpMarketModel";
import { remoteUnsupportedByProfile } from "./resourceCenterModel";

const market = (patch: Partial<McpMarketServer> = {}): McpMarketServer => ({
  id: "x", name: "x", title: "X", description: "en", publisher: "p", icon: "", homepage: "", transport: "stdio", runs: "npx",
  signIn: false, featured: true, inputs: [], command: "npx", args: ["-y", "pkg@latest"], url: "", headers: {}, ...patch,
});
const input = (patch: Partial<McpMarketInput>): McpMarketInput => ({ key: "K", where: "env", label: "K", secret: false, required: false, ...patch });
const installed = (patch: Record<string, unknown>) => ({ name: "other", status: "stopped", config: { command: "", args: [], env: {}, shared: true, port: 0, bridgeMode: "mcp-proxy", ...patch } }) as unknown as SharedMcpServerInfo;

describe("serverIdentity / installedServer", () => {
  it("按身份匹配，不看名称、版本和结尾斜杠", () => {
    expect(serverIdentity({ command: "npx", args: ["-y", "pkg@latest"] })).toBe("npx pkg");
    expect(serverIdentity({ url: "https://A.dev/mcp/" })).toBe("https://a.dev/mcp");
    expect(installedServer(market(), [installed({ command: "npx", args: ["-y", "pkg"] })])).toBeDefined();
    expect(installedServer(market({ url: "https://a.dev/mcp" }), [installed({ remote: { url: "https://a.dev/mcp/", transport: "http", headers: {} } })])).toBeDefined();
    expect(installedServer(market(), [installed({ command: "npx", args: ["-y", "other"] })])).toBeUndefined();
  });
});

describe("输入项", () => {
  it("只有必填项才必须先打开表单", () => {
    expect(needsInputSheet(market({ inputs: [input({ required: false })] }))).toBe(false);
    expect(needsInputSheet(market({ inputs: [input({ required: true })] }))).toBe(true);
  });

  it("空白不算填了必填项", () => {
    const server = market({ inputs: [input({ required: true })] });
    expect(missingRequiredInput(server, { K: "  " })?.key).toBe("K");
    expect(missingRequiredInput(server, { K: "v" })).toBeUndefined();
  });
});

describe("buildSharedConfig", () => {
  it("本地服务器：环境变量和参数放到各自位置，没填的不写", () => {
    const config = buildSharedConfig(
      market({ inputs: [input({ key: "TOKEN" }), input({ key: "OPT" }), input({ key: "dir", where: "arg" })] }),
      { TOKEN: "t", dir: "/code" },
      3105,
    );
    expect(config).toMatchObject({ command: "npx", args: ["-y", "pkg@latest", "/code"], env: { TOKEN: "t" }, port: 3105, remote: null });
  });

  it("远程服务器：请求头套模板，不占端口，保留固定请求头", () => {
    const config = buildSharedConfig(
      market({ url: "https://a.dev/mcp", transport: "http", command: "", args: [], headers: { "X-Fixed": "1" }, inputs: [input({ key: "Authorization", where: "header", format: "Bearer {}" })] }),
      { Authorization: "abc" },
      0,
    );
    expect(config.port).toBe(0);
    expect(config.remote).toEqual({ url: "https://a.dev/mcp", transport: "http", headers: { "X-Fixed": "1", Authorization: "Bearer abc" } });
  });
});

describe("marketDescription", () => {
  it("中文界面优先中文，没有就回退英文", () => {
    expect(marketDescription(market({ descriptionZh: "中" }), "zh-CN")).toBe("中");
    expect(marketDescription(market(), "zh-CN")).toBe("en");
    expect(marketDescription(market({ descriptionZh: "中" }), "en")).toBe("en");
  });
});

describe("remoteUnsupportedByProfile 与后端规则一致", () => {
  const remote = (transport: "http" | "sse", header = false) => ({ url: "https://a", transport, headers: (header ? { A: "b" } : {}) as Record<string, string> });
  it.each([
    [["claude"], remote("sse", true), undefined, false],
    [["codex"], remote("http", true), undefined, false],
    [["codex"], remote("sse"), undefined, true],
    // docs/110 批 2：jcode 放开 http/sse，opencode 放开请求头，antigravity 没有 SSE
    [["jcode"], remote("http"), undefined, false],
    [["opencode"], remote("http", true), undefined, false],
    [["opencode"], remote("sse"), undefined, true],
    [["antigravity"], remote("sse"), undefined, true],
    [["kimi"], remote("sse", true), undefined, false],
    // 启动档本机 / WSL / SSH 通用：旧数据里的 targetRuntime 被忽略，按本机判定
    [["claude"], remote("http", true), "wsl", false],
    [[], remote("sse", true), undefined, false],
    [["jcode", "claude"], remote("http"), undefined, false],
  ] as const)("%j %j %s → %s", (tools, spec, runtime, expected) => {
    const profile = { targetTools: [...tools], targetRuntime: runtime as never };
    expect(remoteUnsupportedByProfile(profile, spec)).toBe(expected);
  });
});

describe("marketReachSource（docs/110 批 5）", () => {
  it("本地条目按共享 stdio，远程按传输方式与是否需要请求头", () => {
    expect(marketReachSource(market())).toEqual({ kind: "shared", remote: null });
    expect(marketReachSource(market({ url: "https://x", transport: "sse" }))).toEqual({
      kind: "shared",
      remote: { transport: "sse", hasHeaders: false },
    });
    expect(marketReachSource(market({ url: "https://x", transport: "streamable-http", inputs: [input({ where: "header" })] }))).toEqual({
      kind: "shared",
      remote: { transport: "http", hasHeaders: true },
    });
  });
});

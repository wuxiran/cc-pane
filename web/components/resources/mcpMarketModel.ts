// 发现市场的纯函数层：判断是否已添加，把卡片和填写的值变成共享 MCP 配置。
import type { McpReachSource } from "@/lib/mcpReach";
import type { McpMarketServer, SharedMcpServerConfig, SharedMcpServerInfo } from "@/types/shared-mcp";

/** 同一个服务器的身份：远程看 URL，本地看命令和包名（去掉版本）。和后端 server_key 同口径。 */
export function serverIdentity(server: { url?: string | null; command?: string; args?: readonly string[] }): string {
  if (server.url) return server.url.replace(/\/+$/, "").toLowerCase();
  const packageArg = server.args?.find((arg) => arg && !arg.startsWith("-") && arg !== "run") ?? "";
  const at = packageArg.lastIndexOf("@");
  return `${server.command ?? ""} ${at > 0 ? packageArg.slice(0, at) : packageArg}`;
}

/** 市场条目对应的已添加服务器；按身份匹配，不按名称。 */
export function installedServer(market: McpMarketServer, installed: readonly SharedMcpServerInfo[]): SharedMcpServerInfo | undefined {
  const key = serverIdentity(market);
  return installed.find((server) =>
    serverIdentity({ url: server.config.remote?.url, command: server.config.command, args: server.config.args }) === key,
  );
}

/** 有必填项才必须先打开表单；选填项可以一键添加后不填。 */
export function needsInputSheet(market: McpMarketServer): boolean {
  return market.inputs.some((input) => input.required);
}

export function missingRequiredInput(market: McpMarketServer, values: Record<string, string>) {
  return market.inputs.find((input) => input.required && !values[input.key]?.trim());
}

export function marketDescription(market: McpMarketServer, language: string): string {
  return language.startsWith("zh") && market.descriptionZh ? market.descriptionZh : market.description;
}

/** 把填写的值放到它该去的位置。没填的选填项不写。 */
export function buildSharedConfig(market: McpMarketServer, values: Record<string, string>, port: number): SharedMcpServerConfig {
  const env: Record<string, string> = {};
  const headers: Record<string, string> = { ...market.headers };
  const args = [...market.args];
  for (const input of market.inputs) {
    const value = values[input.key]?.trim();
    if (!value) continue;
    if (input.where === "env") env[input.key] = value;
    else if (input.where === "header") headers[input.key] = (input.format || "{}").replace("{}", value);
    else args.push(value);
  }
  const remote = market.url
    ? { url: market.url, transport: market.transport === "sse" ? "sse" as const : "http" as const, headers }
    : null;
  return {
    command: remote ? "" : market.command,
    args: remote ? [] : args,
    env: remote ? {} : env,
    shared: true,
    port: remote ? 0 : port,
    bridgeMode: "mcp-proxy",
    remote,
  };
}

/** 添加后它是哪种共享 MCP（「会送到哪些 CLI」用，docs/110 批 5）：远程看传输方式与是否带请求头。 */
export function marketReachSource(market: McpMarketServer): McpReachSource {
  if (!market.url) return { kind: "shared", remote: null };
  const hasHeaders = Object.keys(market.headers).length > 0 || market.inputs.some((input) => input.where === "header");
  return { kind: "shared", remote: { transport: market.transport === "sse" ? "sse" : "http", hasHeaders } };
}

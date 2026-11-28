import "@/i18n";
import i18n from "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sharedMcpService } from "@/services";
import type { LaunchProfile } from "@/types";
import type { McpHubStatus } from "@/types/shared-mcp";
import McpHubCard, { hubProfiles, hubSummary } from "./McpHubCard";

const status: McpHubStatus = {
  endpoint: "http://127.0.0.1:4567/mcp-hub",
  servers: [
    { name: "browser", running: true, routable: true, toolCount: 30 },
    { name: "memory", running: true, routable: true, toolCount: null },
    { name: "fetch", running: false, routable: true, toolCount: null },
    { name: "legacy", running: true, routable: false, toolCount: null },
  ],
};

const profile = (id: string, delivery: "direct" | "hub", mode: "default" | "disabled" = "default", targetTools: string[] = []) =>
  ({
    id,
    targetTools,
    name: id,
    alias: null,
    mcpPolicy: { mode, enabledServerIds: [], disabledServerIds: [], includeCcpanesMcp: true, includeSharedMcp: true, delivery },
  }) as unknown as LaunchProfile;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("McpHubCard 模型", () => {
  it("只数在跑、能代转的服务器；工具数只取已缓存的", () => {
    expect(hubSummary(status)).toEqual({
      servers: 2,
      tools: 30,
      toolsPending: true,
      stopped: ["fetch"],
      direct: ["legacy"],
    });
  });

  it("Hub 投递的启动档不含 MCP 全关的", () => {
    const ids = hubProfiles([profile("a", "hub"), profile("b", "direct"), profile("c", "hub", "disabled")]).map((p) => p.id);
    expect(ids).toEqual(["a"]);
  });
});

describe("McpHubCard 渲染", () => {
  it("没有共享服务器时隐藏且不请求状态", () => {
    const spy = vi.spyOn(sharedMcpService, "getHubStatus");
    render(<McpHubCard active hasShared={false} profiles={[]} />);
    expect(screen.queryByTestId("mcp-hub-card")).not.toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it("拿不到状态（Web 壳）时隐藏", async () => {
    const spy = vi.spyOn(sharedMcpService, "getHubStatus").mockResolvedValue(null);
    render(<McpHubCard active hasShared profiles={[]} />);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(screen.queryByTestId("mcp-hub-card")).not.toBeInTheDocument();
  });

  it("显示端点、聚合数量与使用 Hub 的启动档", async () => {
    vi.spyOn(sharedMcpService, "getHubStatus").mockResolvedValue(status);
    render(<McpHubCard active hasShared profiles={[profile("Codex 工作", "hub"), profile("plain", "direct"), profile("gem", "hub", "default", ["gemini"])]} />);
    expect(await screen.findByTestId("mcp-hub-card")).toBeInTheDocument();
    expect(screen.getByTestId("mcp-hub-endpoint")).toHaveTextContent("127.0.0.1:4567/mcp-hub");
    expect(screen.getByTestId("mcp-hub-profiles")).toHaveTextContent("Codex 工作");
    expect(screen.getByTestId("mcp-hub-profiles")).not.toHaveTextContent("plain");
    // 只面向不支持 Hub 的 CLI：标明回退直连
    expect(screen.getByTestId("mcp-hub-profiles")).toHaveTextContent(
      String(i18n.t("settings:mcpHubCard.fallsBack" as never, { name: "gem" } as never)),
    );
  });
});

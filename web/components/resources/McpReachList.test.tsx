import "@/i18n";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import McpReachList from "./McpReachList";
import type { McpLibraryEntry } from "./mcpLibraryModel";

const sseEntry: McpLibraryEntry = {
  key: "shared:sse",
  kind: "shared",
  name: "sse",
  server: {
    name: "sse",
    config: {
      command: "",
      args: [],
      env: {},
      shared: true,
      port: 0,
      bridgeMode: "mcp-proxy",
      remote: { url: "https://x.example/sse", transport: "sse", headers: {} },
    },
    status: "stopped",
    pid: null,
    url: null,
    restartCount: 0,
  },
};

describe("McpReachList（docs/110 批 5）", () => {
  it("按运行时列出能收到这条 MCP 的 CLI，读注入描述", () => {
    render(<McpReachList entry={sseEntry} />);
    const local = within(screen.getByTestId("mcp-reach-local"));
    expect(local.getByText("claude")).toBeInTheDocument();
    // codex 不收 SSE
    expect(local.queryByText("codex")).not.toBeInTheDocument();
    // WSL 不走 SSE、SSH 不注入
    expect(screen.getByTestId("mcp-reach-wsl")).toHaveTextContent(
      String(i18n.t("settings:resourceLibrary.reachNone" as never)),
    );
    expect(screen.getByTestId("mcp-reach-ssh")).toHaveTextContent(
      String(i18n.t("settings:resourceLibrary.reachSshNone" as never)),
    );
  });
});

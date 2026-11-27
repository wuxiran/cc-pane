import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { defaultLaunchProfileDraft } from "@/types/launch-profile";
import type { LaunchProfileDraft, SshMachine } from "@/types";
import { useSharedMcpStore } from "@/stores/useSharedMcpStore";
import { useSshMachinesStore } from "@/stores/useSshMachinesStore";
import type { SharedMcpServerInfo } from "@/types/shared-mcp";
import type { KnownCliTool } from "@/types/terminal";
import LaunchProfileMcpCard from "./LaunchProfileMcpCard";

// 卡片挂载时会 load SSH 机器：测试里桩掉，避免真去 invoke
beforeEach(() => {
  useSshMachinesStore.setState({ machines: [], load: async () => {} });
});

function renderCard(activeTool: KnownCliTool, mcpPolicy: Partial<LaunchProfileDraft["mcpPolicy"]>) {
  const base = defaultLaunchProfileDraft();
  const draft: LaunchProfileDraft = { ...base, mcpPolicy: { ...base.mcpPolicy, ...mcpPolicy } };
  render(<LaunchProfileMcpCard draft={draft} setDraft={() => {}} activeTool={activeTool} setMcpMode={() => {}} />);
}

describe("LaunchProfileMcpCard 隔离提示（docs/110 批 3）", () => {
  it("收窄 MCP 时，对挡不住自身配置的 CLI 给出提示", () => {
    renderCard("cursor", { disabledServerIds: ["fetch"] });
    expect(screen.getByTestId("mcp-isolation-gap")).toHaveTextContent(
      String(i18n.t("providers:mcpIsolationGap.declareOnly" as never)),
    );
  });

  it.each<[string, KnownCliTool, Partial<LaunchProfileDraft["mcpPolicy"]>]>([
    ["能真正隔离的 CLI", "claude", { mode: "custom" }],
    ["没有收窄", "cursor", {}],
  ])("%s时不提示", (_label, tool, policy) => {
    renderCard(tool, policy);
    expect(screen.queryByTestId("mcp-isolation-gap")).not.toBeInTheDocument();
  });
});

describe("LaunchProfileMcpCard 运行时提示（docs/110 批 4）", () => {
  const sshMachine = { id: "m1", name: "box", host: "box", port: 22, authMethod: "key" } as unknown as SshMachine;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const line = (runtime: string, note: string) => String(i18n.t("providers:mcpRuntimeNoteLine" as never, {
    runtime,
    note: String(i18n.t(`providers:mcpRuntimeNote.${note}` as never)),
  } as never));

  function renderClaude(draftOverrides: Partial<LaunchProfileDraft> = {}) {
    const base = defaultLaunchProfileDraft();
    render(
      <LaunchProfileMcpCard
        draft={{ ...base, ...draftOverrides }}
        setDraft={() => {}}
        activeTool="claude"
        setMcpMode={() => {}}
      />,
    );
  }

  it("非 Windows 且没有登记 SSH 机器时不提示", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    renderClaude();
    expect(screen.queryByTestId("mcp-runtime-note")).not.toBeInTheDocument();
  });

  it("登记了 SSH 机器时给出 SSH 提示（与启动档旧 targetRuntime 无关）", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    useSshMachinesStore.setState({ machines: [sshMachine] });
    renderClaude({ targetRuntime: "wsl" });
    const note = screen.getByTestId("mcp-runtime-note");
    expect(note).toHaveTextContent(line("SSH", "sshNone"));
    expect(note).not.toHaveTextContent(String(i18n.t("providers:mcpRuntimeNote.wslPartial" as never)));
  });

  it("Windows 宿主 + SSH 机器时 WSL 与 SSH 提示都给出", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    useSshMachinesStore.setState({ machines: [sshMachine] });
    renderClaude();
    const note = screen.getByTestId("mcp-runtime-note");
    expect(note).toHaveTextContent(line("WSL", "wslPartial"));
    expect(note).toHaveTextContent(line("SSH", "sshNone"));
  });
});

describe("LaunchProfileMcpCard 新增", () => {
  const server = (name: string) => ({
    name,
    config: { command: "npx", args: ["-y", name], env: {}, shared: true, port: 3100, bridgeMode: "mcp-proxy", remote: null },
    status: "running",
    pid: null,
    url: null,
    restartCount: 0,
  }) as unknown as SharedMcpServerInfo;

  beforeEach(() => {
    useSharedMcpStore.setState({
      servers: [server("context7"), server("fetch")],
      config: null,
      fetchStatus: async () => {},
      fetchConfig: async () => {},
    });
  });

  function renderWith(setDraft: (value: unknown) => void, draftOverrides: Partial<LaunchProfileDraft> = {}, extra: Partial<Parameters<typeof LaunchProfileMcpCard>[0]> = {}) {
    const base = defaultLaunchProfileDraft();
    const draft = { ...base, ...draftOverrides };
    render(<LaunchProfileMcpCard draft={draft} setDraft={setDraft as never} activeTool="claude" setMcpMode={() => {}} {...extra} />);
    return draft;
  }

  it("可以从已有共享 MCP 里勾选开给本配置", () => {
    const setDraft = vi.fn();
    const base = defaultLaunchProfileDraft();
    const draft = renderWith(setDraft, { mcpPolicy: { ...base.mcpPolicy, mode: "custom" } });
    fireEvent.click(screen.getByTestId("mcp-add-trigger"));
    fireEvent.click(screen.getByRole("checkbox", { name: "fetch" }));
    const updater = setDraft.mock.calls[0][0] as (d: LaunchProfileDraft) => LaunchProfileDraft;
    expect(updater(draft).mcpPolicy.enabledServerIds).toContain("fetch");
  });

  it("新建 MCP 服务器打开共享 MCP 编辑框", () => {
    renderWith(vi.fn());
    fireEvent.click(screen.getByTestId("mcp-add-trigger"));
    fireEvent.click(screen.getByTestId("mcp-add-new"));
    expect(screen.getByTestId("shared-mcp-editor")).toBeInTheDocument();
  });

  it("勾选后未保存的新增在卡片里标出来", () => {
    const base = defaultLaunchProfileDraft();
    renderWith(vi.fn(), { mcpPolicy: { ...base.mcpPolicy, mode: "custom", enabledServerIds: ["context7", "fetch"] } }, {
      effective: [{ id: "context7", name: "context7", source: "shared", enabled: true }],
      effectiveStale: true,
    });
    const pending = screen.getByTestId("mcp-pending");
    expect(pending).toHaveTextContent("fetch");
    expect(pending).not.toHaveTextContent("context7");
  });
});

describe("LaunchProfileMcpCard 投递方式（docs/113）", () => {
  const hubTab = () => screen.getByRole("tab", { name: String(i18n.t("providers:mcpDelivery.hub" as never)) });

  beforeEach(() => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    useSharedMcpStore.setState({ servers: [] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Claude / Codex 可选 Hub，并说明 Claude 已原生按需加载", () => {
    renderCard("codex", {});
    expect(hubTab()).not.toBeDisabled();
    expect(screen.getByTestId("mcp-delivery-note")).toHaveTextContent("Codex");
    expect(screen.queryByTestId("mcp-delivery-fallback-cli")).not.toBeInTheDocument();
  });

  it("不支持的 CLI 置灰 Hub 并说明回退直连", () => {
    renderCard("gemini", {});
    expect(hubTab()).toBeDisabled();
    expect(screen.getByTestId("mcp-delivery-fallback-cli")).toBeInTheDocument();
  });

  it("已选 Hub 的启动档在不支持的 CLI 下仍显示选中，并标明回退", () => {
    renderCard("gemini", { delivery: "hub" });
    expect(hubTab()).not.toBeDisabled();
    expect(screen.getByTestId("mcp-delivery-fallback-cli")).toHaveTextContent(
      String(i18n.t("providers:mcpDelivery.fallbackLine" as never, { reason: "" } as never)).trim(),
    );
  });

  it("有 SSE 远程服务器时说明它不经 Hub", () => {
    useSharedMcpStore.setState({
      servers: [{ name: "legacy", config: { shared: true, remote: { url: "https://x/sse", transport: "sse", headers: {} } }, status: "running" } as unknown as SharedMcpServerInfo],
    });
    renderCard("claude", {});
    expect(screen.getByTestId("mcp-delivery-fallback-sse")).toBeInTheDocument();
  });

  it("MCP 全关时不显示投递方式", () => {
    renderCard("claude", { mode: "disabled" });
    expect(screen.queryByTestId("mcp-delivery-note")).not.toBeInTheDocument();
  });
});

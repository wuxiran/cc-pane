import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import AcpRegistryDialog from "./AcpRegistryDialog";
import type { AcpRegistryAgentInfo } from "@/types/agentChat";

const service = vi.hoisted(() => ({
  listRegistry: vi.fn(),
  installRegistryAgent: vi.fn(),
  uninstallRegistryAgent: vi.fn(),
}));
vi.mock("@/services/agentChatService", () => ({ agentChatService: service }));

const tRaw = i18n.t as (key: string, options?: Record<string, unknown>) => string;
const tPanes = (key: string, options?: Record<string, unknown>) => tRaw(key, { ns: "panes", ...options });

function agent(overrides: Partial<AcpRegistryAgentInfo>): AcpRegistryAgentInfo {
  return {
    id: "demo",
    name: "Demo",
    version: "1.0.0",
    description: "",
    repository: null,
    website: null,
    license: null,
    iconUrl: null,
    distribution: "npx",
    builtInEngineId: null,
    installedVersion: null,
    featured: false,
    ...overrides,
  };
}

function row(id: string) {
  return document.querySelector(`[data-agent-id="${id}"]`) as HTMLElement;
}

describe("AcpRegistryDialog", () => {
  beforeEach(() => {
    service.listRegistry.mockReset();
    service.installRegistryAgent.mockReset();
    service.uninstallRegistryAgent.mockReset();
  });

  it("区分内置 / 本机不可用 / 可安装，安装后回调新引擎 id 并标成已安装", async () => {
    service.listRegistry.mockResolvedValue({
      fromCache: false,
      agents: [
        agent({ id: "amp-acp", name: "Amp", distribution: "binary", featured: true }),
        agent({ id: "kiro", name: "Kiro CLI", builtInEngineId: "kiro" }),
        agent({ id: "plan9", name: "Plan9 Agent", distribution: null }),
      ],
    });
    service.installRegistryAgent.mockResolvedValue("acp-registry-amp-acp");
    const onInstalled = vi.fn();
    const user = userEvent.setup();
    render(<AcpRegistryDialog open onOpenChange={vi.fn()} onInstalled={onInstalled} onUninstalled={vi.fn()} />);

    await screen.findByText("Amp");
    expect(within(row("kiro")).getByText(tPanes("acpRegistry.builtIn"))).toBeInTheDocument();
    expect(within(row("plan9")).getByText(tPanes("acpRegistry.unsupported"))).toBeInTheDocument();

    await user.click(within(row("amp-acp")).getByRole("button", { name: tPanes("acpRegistry.install") }));
    expect(service.installRegistryAgent).toHaveBeenCalledWith("amp-acp");
    expect(onInstalled).toHaveBeenCalledWith("acp-registry-amp-acp");
    expect(await within(row("amp-acp")).findByText(tPanes("acpRegistry.installed"))).toBeInTheDocument();
  });

  it("安装失败时错误留在该行，可重试", async () => {
    service.listRegistry.mockResolvedValue({ fromCache: true, agents: [agent({ id: "goose", name: "goose" })] });
    service.installRegistryAgent.mockRejectedValue(new Error("sha256 mismatch"));
    const user = userEvent.setup();
    render(<AcpRegistryDialog open onOpenChange={vi.fn()} onInstalled={vi.fn()} onUninstalled={vi.fn()} />);

    await screen.findByText("goose");
    expect(screen.getByText(tPanes("acpRegistry.offline"))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: tPanes("acpRegistry.install") }));
    expect(await screen.findByRole("alert")).toHaveTextContent("sha256 mismatch");
    expect(screen.getByRole("button", { name: tPanes("acpRegistry.install") })).toBeEnabled();
  });

  it("搜索按名称与描述过滤", async () => {
    service.listRegistry.mockResolvedValue({
      fromCache: false,
      agents: [agent({ id: "a", name: "Alpha", description: "rust agent" }), agent({ id: "b", name: "Beta" })],
    });
    const user = userEvent.setup();
    render(<AcpRegistryDialog open onOpenChange={vi.fn()} onInstalled={vi.fn()} onUninstalled={vi.fn()} />);

    await screen.findByText("Alpha");
    await user.type(screen.getByRole("textbox", { name: tPanes("acpRegistry.search") }), "rust");
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.queryByText("Beta")).not.toBeInTheDocument();
  });
});

import "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentChatService } from "@/services/agentChatService";
import { checkSshConnectivity, listSshMachines } from "@/services/sshMachineService";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { useAgentChatRemoteStore } from "@/stores/useAgentChatRemoteStore";
import { useSshMachinesStore } from "@/stores/useSshMachinesStore";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { SshMachine, Tab } from "@/types";
import type { AcpChatSnapshot } from "@/types/agentChat";
import AgentChatTabContent from "./AgentChatTabContent";

vi.mock("@/services/agentChatService", () => ({ agentChatService: {
  listEngines: vi.fn(), listHistory: vi.fn(), get: vi.fn(), listen: vi.fn(), start: vi.fn(),
  setMode: vi.fn(), setModel: vi.fn(), setConfigOption: vi.fn(), prompt: vi.fn(),
} }));
vi.mock("@/services/sshMachineService", () => ({ listSshMachines: vi.fn(), checkSshConnectivity: vi.fn() }));
vi.mock("@/services/gitService", () => ({ gitService: {
  getRepoInfo: vi.fn().mockResolvedValue({ state: "ok", branch: "main", repoRoot: "/project", hasChanges: false }),
  getLocalBranches: vi.fn().mockResolvedValue(["main"]),
} }));
vi.mock("./ChatVoiceButton", () => ({ default: () => null }));
vi.mock("./ChatTurnView", () => ({ default: () => null }));

const CHAT = "remote-chat-test";
const tab = { id: CHAT, title: "Agent", projectPath: "/project", contentType: "agent-chat" } as Tab;
const machine = (patch: Partial<SshMachine>): SshMachine => ({
  id: "m1", name: "box", host: "10.0.0.2", port: 22, authMethod: "key", tags: [],
  defaultPath: "~/work", createdAt: "", updatedAt: "", ...patch,
});
const machines = [
  machine({}),
  machine({ id: "m2", name: "pw-box", host: "10.0.0.3", authMethod: "password" }),
  machine({ id: "m3", name: "jump-box", host: "10.0.0.4", jumpHost: { host: "bastion", port: 22 } }),
];
const ready: AcpChatSnapshot = { chatId: CHAT, engineId: "claude", phase: "ready", acpSessionId: "s1" };
const renderChat = () => render(<TooltipProvider><AgentChatTabContent tab={tab} /></TooltipProvider>);
const openSettings = async () => userEvent.click(await screen.findByRole("button", { name: "配置启动环境" }));
async function send() {
  await act(async () => { fireEvent.change(screen.getByRole("textbox"), { target: { value: "task" } }); });
  await act(async () => { fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" }); });
}

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  useAgentChatStore.getState().dropChat(CHAT);
  useAgentChatRemoteStore.getState().setTarget(CHAT, null);
  useSshMachinesStore.setState({ machines: [] });
  vi.mocked(listSshMachines).mockResolvedValue(machines);
  vi.mocked(checkSshConnectivity).mockResolvedValue({ reachable: true, message: "ok", latencyMs: 12, os: "linux" });
  vi.mocked(agentChatService.get).mockResolvedValue(null);
  vi.mocked(agentChatService.listen).mockResolvedValue(() => {});
  vi.mocked(agentChatService.listEngines).mockResolvedValue([{ id: "claude", label: "Claude", available: true, requirement: "" }]);
  vi.mocked(agentChatService.listHistory).mockResolvedValue([]);
  vi.mocked(agentChatService.start).mockResolvedValue(ready);
  vi.mocked(agentChatService.prompt).mockResolvedValue(undefined);
});

describe("remote agent chat", () => {
  it("lists saved machines and disables password and routed ones", async () => {
    renderChat();
    await openSettings();
    expect(await screen.findByRole("radio", { name: /box.*10\.0\.0\.2/ })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /本地/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /pw-box/ })).toBeDisabled();
    expect(screen.getByText("密码认证的机器暂不支持远程对话")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /jump-box/ })).toBeDisabled();
    expect(screen.getByText("经代理或跳板机连接的机器暂不支持远程对话")).toBeInTheDocument();
  });

  it("starts on the picked machine with the remote directory and hides local affordances", async () => {
    renderChat();
    expect(await screen.findByRole("button", { name: "审阅更改" })).toBeInTheDocument();
    await openSettings();
    await userEvent.click(await screen.findByRole("radio", { name: /box.*10\.0\.0\.2/ }));
    expect(checkSshConnectivity).toHaveBeenCalledExactlyOnceWith("m1");
    expect(screen.getByRole("textbox", { name: "远程目录" })).toHaveValue("~/work");
    expect(await screen.findByText("已连通 · linux")).toBeInTheDocument();
    expect(screen.getByRole("switch")).toBeDisabled();
    expect(screen.getByTestId("worktree-reason")).toHaveTextContent("仅本地环境可用");
    fireEvent.change(screen.getByRole("textbox", { name: "远程目录" }), { target: { value: "~/proj" } });
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "配置启动环境" })).toHaveTextContent("box");
    expect(screen.queryByRole("button", { name: "审阅更改" })).not.toBeInTheDocument();
    expect(screen.getByTestId("start-remote-target")).toHaveTextContent("box · ~/proj");
    await send();
    await waitFor(() => expect(agentChatService.start).toHaveBeenCalledWith(
      CHAT, "claude", "~/proj", undefined, [], { machineId: "m1", os: "linux" }));
  });

  it("still allows trying an unreachable machine and shows why", async () => {
    vi.mocked(checkSshConnectivity).mockResolvedValue({ reachable: false, message: "timed out", latencyMs: null });
    renderChat();
    await openSettings();
    await userEvent.click(await screen.findByRole("radio", { name: /box.*10\.0\.0\.2/ }));
    expect(await screen.findByTestId("remote-probe-error")).toHaveTextContent("timed out");
    await userEvent.keyboard("{Escape}");
    await send();
    await waitFor(() => expect(agentChatService.start).toHaveBeenCalledWith(
      CHAT, "claude", "~/work", undefined, [], { machineId: "m1", os: null }));
  });

  it("keeps the local start exactly as before", async () => {
    renderChat();
    await screen.findByRole("button", { name: "审阅更改" });
    await send();
    await waitFor(() => expect(agentChatService.start).toHaveBeenCalled());
    expect(vi.mocked(agentChatService.start).mock.calls[0]).toEqual([CHAT, "claude", "/project", undefined, []]);
    expect(checkSshConnectivity).not.toHaveBeenCalled();
  });

  it("restarts an ended remote chat on the same machine and shows the remote target", async () => {
    useAgentChatRemoteStore.getState().setTarget(CHAT, {
      machineId: "m1", machineName: "box", host: "10.0.0.2", cwd: "~/proj", os: "linux",
      probe: { status: "reachable", latencyMs: 5 }, probeSeq: 1,
    });
    useAgentChatStore.getState().setSnapshot(CHAT, { ...ready, phase: "exited" });
    renderChat();
    expect(screen.getByTestId("remote-target-chip")).toHaveTextContent("box · ~/proj");
    expect(screen.queryByRole("button", { name: "审阅更改" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /重新启动会话/ }));
    await waitFor(() => expect(agentChatService.start).toHaveBeenCalledWith(
      CHAT, "claude", "~/proj", "s1", [], { machineId: "m1", os: "linux" }));
  });
});

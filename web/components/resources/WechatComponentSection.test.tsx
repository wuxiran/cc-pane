import "@/i18n";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { WechatComponentStatus } from "@/services";
import { useSharedMcpStore } from "@/stores/useSharedMcpStore";
import type { SharedMcpServerInfo } from "@/types";
import WechatComponentSection from "./WechatComponentSection";
import { remoteFromForm } from "./WechatRemoteDialog";

const wechat = vi.hoisted(() => ({
  status: vi.fn(),
  enableLocal: vi.fn(),
  enableRemote: vi.fn(),
  disable: vi.fn(),
  check: vi.fn(),
}));
const listSshMachines = vi.hoisted(() => vi.fn(async () => []));

vi.mock("@/services", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services")>()),
  wechatComponentService: wechat,
  sshMachineService: { listSshMachines },
}));
vi.mock("@/services/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/runtime")>()),
  isTauriRuntime: () => true,
}));
vi.mock("@/lib/feedback", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  toastOk: vi.fn(),
  toastErr: vi.fn(),
}));

const tw = (key: string, opts?: Record<string, unknown>) => String(i18n.t(`settings:wechatComponent.${key}` as never, opts as never));

function server(command: string, args: string[] = [], port = 3120): SharedMcpServerInfo {
  return {
    name: "wechat",
    config: { command, args, env: {}, shared: true, port, bridgeMode: "native-http" },
    status: "running",
    pid: 42,
    url: `http://127.0.0.1:${port}/mcp`,
    restartCount: 0,
  } as SharedMcpServerInfo;
}

function status(overrides: Partial<WechatComponentStatus> = {}): WechatComponentStatus {
  return { localSupported: true, binaryFound: true, mode: "off", remote: null, server: null, ...overrides };
}

beforeEach(() => {
  for (const fn of Object.values(wechat)) fn.mockReset();
  listSshMachines.mockClear();
  useSharedMcpStore.setState({ servers: [], fetchStatus: vi.fn(async () => {}) } as never);
});

describe("WechatComponentSection", () => {
  it("Windows 上可在本机启用，启用后自动检测并显示结果", async () => {
    const local = server("C:\\CC-Panes\\binaries\\cc-wechat-mcp.exe");
    wechat.status.mockResolvedValue(status());
    wechat.enableLocal.mockImplementation(async () => {
      useSharedMcpStore.setState({ servers: [local] } as never);
      return status({ mode: "local", server: local });
    });
    wechat.check.mockResolvedValue({ ok: true, running: true, pid: 1234, message_dbs: ["message_0.db", "message_1.db"] });
    const user = userEvent.setup();
    render(<WechatComponentSection active />);

    await user.click(await screen.findByRole("button", { name: tw("enableLocal") }));
    expect(wechat.enableLocal).toHaveBeenCalledTimes(1);
    const card = screen.getByTestId("wechat-component");
    await waitFor(() => expect(card).toHaveAttribute("data-mode", "local"));
    expect(within(card).getByText(tw("modeLocal", { port: 3120 }))).toBeInTheDocument();
    expect(await screen.findByTestId("wechat-check-result", {}, { timeout: 3000 })).toHaveTextContent(tw("checkOk", { pid: 1234, count: 2 }));

    await user.click(within(card).getByRole("button", { name: tw("disable") }));
    expect(wechat.disable).toHaveBeenCalledTimes(1);
  });

  it("非 Windows 只能连远程：填主机后按默认端口建隧道", async () => {
    wechat.status.mockResolvedValue(status({ localSupported: false }));
    const tunnel = server("/usr/bin/ssh", ["-N", "-L", "127.0.0.1:3120:127.0.0.1:3120", "me@10.0.0.5"]);
    wechat.enableRemote.mockImplementation(async () => {
      useSharedMcpStore.setState({ servers: [tunnel] } as never);
      return status({ localSupported: false, mode: "remote", remote: { target: "me@10.0.0.5", remotePort: 3120 }, server: tunnel });
    });
    wechat.check.mockResolvedValue({ ok: false, running: false, error: "未找到 Weixin.exe 进程" });
    const user = userEvent.setup();
    render(<WechatComponentSection active />);

    expect(await screen.findByText(tw("remoteOnlyHint"))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: tw("enableLocal") })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: tw("connectRemote") }));
    const dialog = await screen.findByTestId("wechat-remote-dialog");
    await user.click(within(dialog).getByRole("button", { name: tw("connect") }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(tw("targetInvalid"));

    await user.type(within(dialog).getByLabelText(tw("fieldTarget")), "me@10.0.0.5");
    await user.click(within(dialog).getByRole("button", { name: tw("connect") }));
    await waitFor(() => expect(wechat.enableRemote).toHaveBeenCalledWith({ target: "me@10.0.0.5", remotePort: 3120 }));
    await waitFor(() => expect(screen.queryByTestId("wechat-remote-dialog")).not.toBeInTheDocument());
    expect(screen.getByText(tw("modeRemote", { target: "me@10.0.0.5", port: 3120 }))).toBeInTheDocument();
    const result = await screen.findByTestId("wechat-check-result", {}, { timeout: 3000 });
    expect(result).toHaveTextContent("未找到 Weixin.exe 进程");
  });

  it("远程连接失败时错误留在对话框里", async () => {
    wechat.status.mockResolvedValue(status({ localSupported: false }));
    wechat.enableRemote.mockRejectedValue(new Error("Failed to spawn 'wechat'"));
    const user = userEvent.setup();
    render(<WechatComponentSection active />);
    await user.click(await screen.findByRole("button", { name: tw("connectRemote") }));
    const dialog = await screen.findByTestId("wechat-remote-dialog");
    await user.type(within(dialog).getByLabelText(tw("fieldTarget")), "win-box");
    await user.click(within(dialog).getByRole("button", { name: tw("connect") }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Failed to spawn");
    expect(screen.getByTestId("wechat-remote-dialog")).toBeInTheDocument();
  });

  it("用户手配的 wechat 条目不提供停用，只提供改用内置组件", async () => {
    const custom = server("node", ["mcp-proxy.mjs", "--port", "3100"], 3100);
    useSharedMcpStore.setState({ servers: [custom] } as never);
    wechat.status.mockResolvedValue(status({ mode: "custom", server: custom }));
    render(<WechatComponentSection active />);
    const card = await screen.findByTestId("wechat-component");
    expect(within(card).getByText(tw("modeCustom"))).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: tw("switchToBuiltin") })).toBeEnabled();
    expect(within(card).queryByRole("button", { name: tw("disable") })).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: tw("check") })).not.toBeInTheDocument();
  });

  it("组件程序缺失时本机启用按钮不可点", async () => {
    wechat.status.mockResolvedValue(status({ binaryFound: false }));
    render(<WechatComponentSection active />);
    expect(await screen.findByRole("button", { name: tw("enableLocal") })).toBeDisabled();
  });

  it("上方列表删掉 wechat 条目后重新读取模式", async () => {
    const local = server("/x/cc-wechat-mcp");
    useSharedMcpStore.setState({ servers: [local] } as never);
    wechat.status.mockResolvedValueOnce(status({ mode: "local", server: local })).mockResolvedValue(status());
    render(<WechatComponentSection active />);
    await waitFor(() => expect(screen.getByTestId("wechat-component")).toHaveAttribute("data-mode", "local"));
    act(() => useSharedMcpStore.setState({ servers: [] } as never));
    await waitFor(() => expect(screen.getByTestId("wechat-component")).toHaveAttribute("data-mode", "off"));
  });
});

describe("remoteFromForm", () => {
  const base = { target: "win-box", sshPort: "", identityFile: "", remotePort: "3120" };

  it("只带填了的可选项", () => {
    expect(remoteFromForm(base)).toEqual({ target: "win-box", remotePort: 3120 });
    expect(remoteFromForm({ ...base, sshPort: "2222", identityFile: " ~/.ssh/k " })).toEqual({
      target: "win-box",
      remotePort: 3120,
      sshPort: 2222,
      identityFile: "~/.ssh/k",
    });
  });

  it("拒绝选项注入和非法端口", () => {
    expect(remoteFromForm({ ...base, target: "-oProxyCommand=x" })).toEqual({ error: "wechatComponent.targetInvalid" });
    expect(remoteFromForm({ ...base, target: "a b" })).toEqual({ error: "wechatComponent.targetInvalid" });
    expect(remoteFromForm({ ...base, remotePort: "" })).toEqual({ error: "wechatComponent.portInvalid" });
    expect(remoteFromForm({ ...base, remotePort: "70000" })).toEqual({ error: "wechatComponent.portInvalid" });
    expect(remoteFromForm({ ...base, sshPort: "22x" })).toEqual({ error: "wechatComponent.portInvalid" });
  });
});

import "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { settingsService } from "@/services";
import { isTauriRuntime } from "@/services/runtime";
import { useSettingsStore } from "@/stores";
import type { AppSettings, WebAccessSettings, WebAccessStatus } from "@/types";
import WebAccessSection from "./WebAccessSection";

vi.mock("@/services/runtime", () => ({
  isTauriRuntime: vi.fn(() => true),
  isWebRuntime: vi.fn(() => false),
  invokeIfTauri: vi.fn(async () => undefined),
  listenIfTauri: vi.fn(async () => () => {}),
  listenWebviewIfTauri: vi.fn(async () => () => {}),
  getCurrentWindowIfTauri: vi.fn(() => null),
  logErrorSafe: vi.fn(),
  logInfoSafe: vi.fn(),
}));

vi.mock("@/services/settingsService", () => ({
  settingsService: {
    getWebAccessStatus: vi.fn(),
    setWebAccessPassword: vi.fn(),
    startWebAccess: vi.fn(),
    stopWebAccess: vi.fn(),
    restartWebAccess: vi.fn(),
    openWebAccess: vi.fn(),
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

const idleStatus: WebAccessStatus = {
  enabled: true,
  running: false,
  pid: null,
  url: "http://127.0.0.1:18080",
  bindHost: "127.0.0.1",
  port: 18080,
  lanRequested: false,
  lanActive: false,
  authRequired: false,
  passwordConfigured: false,
};

function createValue(overrides: Partial<WebAccessSettings> = {}): WebAccessSettings {
  return {
    enabled: false,
    autoOpen: false,
    port: 18080,
    allowLan: false,
    ipWhitelist: [],
    authEnabled: false,
    username: "admin",
    passwordSalt: null,
    passwordHash: null,
    lockOnIdleMinutes: 30,
    remoteReadOnly: false,
    ...overrides,
  };
}

const loadSettingsMock = vi.fn(async () => {});

describe("WebAccessSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    vi.mocked(settingsService.getWebAccessStatus).mockResolvedValue(idleStatus);
    useSettingsStore.setState({
      settings: { webAccess: createValue() } as AppSettings,
      loadSettings: loadSettingsMock,
    });
  });

  it("fetches and renders the service status on mount", async () => {
    render(<WebAccessSection value={createValue()} onChange={vi.fn()} />);
    await act(async () => {});

    expect(await screen.findByText(/未运行 · http:\/\/127\.0\.0\.1:18080/)).toBeInTheDocument();
    expect(settingsService.getWebAccessStatus).toHaveBeenCalled();
  });

  it("emits enabled/autoOpen/authEnabled checkbox changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<WebAccessSection value={createValue()} onChange={onChange} />);
    await act(async () => {});

    const checkboxes = screen.getAllByRole("checkbox");
    // 顺序：enabled → autoOpen → authEnabled → allowLan
    await user.click(checkboxes[0]);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));

    await user.click(checkboxes[1]);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ autoOpen: true }));

    await user.click(checkboxes[2]);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ authEnabled: true }));
  });

  it("resets the port to 18080 via the reset button", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<WebAccessSection value={createValue({ port: 9999 })} onChange={onChange} />);
    await act(async () => {});

    await user.click(screen.getByRole("button", { name: /重置/ }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ port: 18080 }));
  });

  it("keeps LAN access locked until auth is enabled and a password exists", async () => {
    useSettingsStore.setState({ settings: { webAccess: createValue() } as AppSettings });
    const { rerender } = render(<WebAccessSection value={createValue()} onChange={vi.fn()} />);
    await act(async () => {});

    let checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[3]).toBeDisabled();

    rerender(
      <WebAccessSection
        value={createValue({ authEnabled: true, passwordHash: "hash" })}
        onChange={vi.fn()}
      />,
    );
    checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[3]).not.toBeDisabled();
  });

  it("falls back to the stored password hash to unlock LAN access", async () => {
    useSettingsStore.setState({
      settings: { webAccess: createValue({ passwordHash: "stored-hash" }) } as AppSettings,
    });
    render(
      <WebAccessSection value={createValue({ authEnabled: true })} onChange={vi.fn()} />,
    );
    await act(async () => {});

    expect(screen.getAllByRole("checkbox")[3]).not.toBeDisabled();
  });

  it("splits the IP whitelist on newlines and commas, dropping blanks", async () => {
    const onChange = vi.fn();
    render(<WebAccessSection value={createValue()} onChange={onChange} />);
    await act(async () => {});

    fireEvent.change(screen.getByPlaceholderText("192.168.1.20"), {
      target: { value: "192.168.1.20\n10.0.0.1, ,192.168.1.30" },
    });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ ipWhitelist: ["192.168.1.20", "10.0.0.1", "192.168.1.30"] }),
    );
  });

  it("saves the password then reloads settings and status", async () => {
    const user = userEvent.setup();
    vi.mocked(settingsService.setWebAccessPassword).mockResolvedValue(undefined as never);
    render(<WebAccessSection value={createValue()} onChange={vi.fn()} />);
    await act(async () => {});

    await user.type(screen.getByPlaceholderText(/请输入 Web 登录密码/), "s3cret");
    await user.click(screen.getByRole("button", { name: /保存密码/ }));

    await waitFor(() =>
      expect(settingsService.setWebAccessPassword).toHaveBeenCalledWith("s3cret"),
    );
    expect(loadSettingsMock).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalled();
    // 输入框被清空
    expect(screen.getByPlaceholderText(/请输入 Web 登录密码/)).toHaveValue("");
  });

  it("shows an error toast when saving the password fails", async () => {
    const user = userEvent.setup();
    vi.mocked(settingsService.setWebAccessPassword).mockRejectedValue(new Error("io"));
    render(<WebAccessSection value={createValue()} onChange={vi.fn()} />);
    await act(async () => {});

    await user.click(screen.getByRole("button", { name: /保存密码/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it("drives the web service lifecycle buttons in desktop runtime", async () => {
    const user = userEvent.setup();
    const runningStatus = { ...idleStatus, running: true };
    vi.mocked(settingsService.startWebAccess).mockResolvedValue(runningStatus);
    vi.mocked(settingsService.stopWebAccess).mockResolvedValue(idleStatus);
    vi.mocked(settingsService.restartWebAccess).mockResolvedValue(runningStatus);
    vi.mocked(settingsService.openWebAccess).mockResolvedValue(undefined as never);
    render(<WebAccessSection value={createValue()} onChange={vi.fn()} />);
    await act(async () => {});

    await user.click(screen.getByRole("button", { name: /打开 Web/ }));
    await waitFor(() => expect(settingsService.openWebAccess).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: /启动/ }));
    await waitFor(() => expect(settingsService.startWebAccess).toHaveBeenCalled());
    expect(await screen.findByText(/运行中/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /停止/ }));
    await waitFor(() => expect(settingsService.stopWebAccess).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: /重启/ }));
    await waitFor(() => expect(settingsService.restartWebAccess).toHaveBeenCalled());
  });

  it("hides start/stop/restart outside the desktop runtime", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(false);
    render(<WebAccessSection value={createValue()} onChange={vi.fn()} />);
    await act(async () => {});

    expect(screen.getByRole("button", { name: /打开 Web/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^启动$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /停止/ })).not.toBeInTheDocument();
  });
});

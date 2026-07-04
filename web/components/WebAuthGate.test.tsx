import "@/i18n";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebAuthGate from "./WebAuthGate";
import { webAuthService, type WebAuthStatus } from "@/services/webAuthService";

vi.mock("@/services/webAuthService", () => ({
  webAuthService: {
    status: vi.fn(),
    login: vi.fn(),
    lock: vi.fn(),
  },
}));

function makeStatus(overrides: Partial<WebAuthStatus> = {}): WebAuthStatus {
  return {
    authRequired: true,
    authenticated: false,
    username: "admin",
    passwordConfigured: true,
    allowLan: false,
    lockOnIdleMinutes: 0,
    readOnly: false,
    ...overrides,
  };
}

const Child = () => <div data-testid="child">受保护内容</div>;

describe("WebAuthGate", () => {
  let savedInternals: unknown;

  beforeEach(() => {
    vi.mocked(webAuthService.status).mockReset();
    vi.mocked(webAuthService.login).mockReset();
    vi.mocked(webAuthService.lock).mockReset();
    // 默认切换到 Web 运行时（删除 Tauri 标记）
    savedInternals = window.__TAURI_INTERNALS__;
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = savedInternals;
  });

  it("Tauri 运行时直接渲染子组件，不请求鉴权状态", () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    render(<WebAuthGate><Child /></WebAuthGate>);
    expect(screen.getByTestId("child")).toBeInTheDocument();
    expect(webAuthService.status).not.toHaveBeenCalled();
  });

  it("状态加载中显示 Loading 占位", () => {
    vi.mocked(webAuthService.status).mockReturnValue(new Promise<WebAuthStatus>(() => {}));
    render(<WebAuthGate><Child /></WebAuthGate>);
    expect(screen.getByText(/Loading CC-Panes/i)).toBeInTheDocument();
    expect(screen.queryByTestId("child")).not.toBeInTheDocument();
  });

  it("无需鉴权时渲染子组件", async () => {
    vi.mocked(webAuthService.status).mockResolvedValue(makeStatus({ authRequired: false }));
    render(<WebAuthGate><Child /></WebAuthGate>);
    expect(await screen.findByTestId("child")).toBeInTheDocument();
  });

  it("已认证时渲染子组件", async () => {
    vi.mocked(webAuthService.status).mockResolvedValue(makeStatus({ authenticated: true }));
    render(<WebAuthGate><Child /></WebAuthGate>);
    expect(await screen.findByTestId("child")).toBeInTheDocument();
  });

  it("需要鉴权且未登录时显示锁定表单", async () => {
    vi.mocked(webAuthService.status).mockResolvedValue(makeStatus());
    render(<WebAuthGate><Child /></WebAuthGate>);
    expect(await screen.findByText(/Web 已锁定/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("账号")).toHaveValue("admin");
    expect(screen.queryByTestId("child")).not.toBeInTheDocument();
  });

  it("提交登录成功后重新拉取状态并放行", async () => {
    const user = userEvent.setup();
    vi.mocked(webAuthService.status)
      .mockResolvedValueOnce(makeStatus())
      .mockResolvedValueOnce(makeStatus({ authenticated: true }));
    vi.mocked(webAuthService.login).mockResolvedValue();

    render(<WebAuthGate><Child /></WebAuthGate>);
    await screen.findByText(/Web 已锁定/);

    await user.type(screen.getByPlaceholderText("密码"), "secret");
    await user.click(screen.getByRole("button", { name: /解锁/ }));

    expect(webAuthService.login).toHaveBeenCalledWith({ username: "admin", password: "secret" });
    expect(await screen.findByTestId("child")).toBeInTheDocument();
  });

  it("登录失败显示错误信息", async () => {
    const user = userEvent.setup();
    vi.mocked(webAuthService.status).mockResolvedValue(makeStatus());
    vi.mocked(webAuthService.login).mockRejectedValue(new Error("密码错误"));

    render(<WebAuthGate><Child /></WebAuthGate>);
    await screen.findByText(/Web 已锁定/);

    await user.type(screen.getByPlaceholderText("密码"), "wrong");
    await user.click(screen.getByRole("button", { name: /解锁/ }));

    expect(await screen.findByText(/密码错误/)).toBeInTheDocument();
    expect(screen.queryByTestId("child")).not.toBeInTheDocument();
  });

  it("状态请求失败时展示错误而非 Loading", async () => {
    vi.mocked(webAuthService.status).mockRejectedValue(new Error("网络异常"));
    render(<WebAuthGate><Child /></WebAuthGate>);
    expect(await screen.findByText(/网络异常/)).toBeInTheDocument();
  });
});

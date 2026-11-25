import "@/i18n";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { FeishuJob, FeishuStatus } from "@/services";
import FeishuCliCard from "./FeishuCliCard";

const feishu = vi.hoisted(() => ({
  status: vi.fn(),
  install: vi.fn(async () => {}),
  start: vi.fn(async () => {}),
  installSkills: vi.fn(async () => {}),
  cancel: vi.fn(async () => {}),
  logout: vi.fn(async () => {}),
}));
const openExternalUrl = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/services", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services")>()),
  feishuCliService: feishu,
}));
vi.mock("@/services/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/runtime")>()),
  isTauriRuntime: () => true,
}));
vi.mock("./libraryChrome", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openExternalUrl,
}));
vi.mock("@/lib/feedback", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  toastOk: vi.fn(),
  toastErr: vi.fn(),
}));

const tf = (key: string, opts?: Record<string, unknown>) => String(i18n.t(`settings:feishuCli.${key}` as never, opts as never));

function status(overrides: Partial<FeishuStatus> = {}): FeishuStatus {
  return {
    npmFound: true,
    installed: false,
    version: null,
    configured: false,
    appId: null,
    brand: null,
    identity: null,
    skillsInstalled: [],
    skillsTotal: 25,
    job: null,
    ...overrides,
  };
}

function job(overrides: Partial<FeishuJob>): FeishuJob {
  return { kind: "install", stage: "running", url: null, done: 0, total: 0, error: null, ...overrides };
}

beforeEach(() => {
  for (const fn of Object.values(feishu)) fn.mockClear();
  feishu.status.mockReset();
  openExternalUrl.mockClear();
});

describe("FeishuCliCard", () => {
  it("没装时只给安装按钮，点了开始安装", async () => {
    feishu.status.mockResolvedValue(status());
    const user = userEvent.setup();
    render(<FeishuCliCard active />);
    const step1 = await screen.findByTestId("feishu-step-1");
    await user.click(within(step1).getByRole("button", { name: tf("install") }));
    expect(feishu.install).toHaveBeenCalledTimes(1);
    // 没装好之前，后面几步不出操作按钮
    expect(within(screen.getByTestId("feishu-step-2")).queryByRole("button")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("feishu-step-3")).queryByRole("button")).not.toBeInTheDocument();
  });

  it("没有 npm 时安装按钮不可点并说明原因", async () => {
    feishu.status.mockResolvedValue(status({ npmFound: false }));
    render(<FeishuCliCard active />);
    const step1 = await screen.findByTestId("feishu-step-1");
    expect(within(step1).getByText(tf("npmMissing"))).toBeInTheDocument();
    expect(within(step1).getByRole("button", { name: tf("install") })).toBeDisabled();
  });

  it("配置进行中拿到链接后在页面上显示二维码，不自动弹浏览器，可取消", async () => {
    const url = "https://open.feishu.cn/page/cli?user_code=AB";
    feishu.status.mockResolvedValue(status({ installed: true, version: "1.0.100", job: job({ kind: "config", url }) }));
    const user = userEvent.setup();
    render(<FeishuCliCard active />);
    const step2 = await screen.findByTestId("feishu-step-2");
    expect(within(step2).getByText(tf("waitingScan"))).toBeInTheDocument();
    const qr = within(step2).getByTestId("feishu-auth-qr");
    expect(qr).toHaveAttribute("data-payload", url);
    expect(within(qr).getByTitle(tf("qrTitle"))).toBeInTheDocument();
    // 轮询期间不会自己弹浏览器，点按钮才打开
    await waitFor(() => expect(feishu.status.mock.calls.length).toBeGreaterThan(1), { timeout: 2500 });
    expect(openExternalUrl).not.toHaveBeenCalled();
    await user.click(within(qr).getByRole("button", { name: tf("openInBrowser") }));
    expect(openExternalUrl).toHaveBeenCalledWith(url);
    expect(within(step2).getByRole("button", { name: tf("configure") })).toBeDisabled();
    await user.click(within(step2).getByRole("button", { name: tf("cancel") }));
    expect(feishu.cancel).toHaveBeenCalledTimes(1);
  });

  it("已登录时显示退出；Skills 没装全时可以补全", async () => {
    feishu.status.mockResolvedValue(status({
      installed: true,
      version: "1.0.100",
      configured: true,
      appId: "cli_a1",
      identity: "user",
      skillsInstalled: ["lark-shared", "lark-im"],
    }));
    const user = userEvent.setup();
    render(<FeishuCliCard active />);
    const step3 = await screen.findByTestId("feishu-step-3");
    expect(step3).toHaveAttribute("data-done", "true");
    expect(within(screen.getByTestId("feishu-step-2")).getByText(tf("configured", { appId: "cli_a1" }))).toBeInTheDocument();
    await user.click(within(step3).getByRole("button", { name: tf("logout") }));
    expect(feishu.logout).toHaveBeenCalledTimes(1);
    const step4 = screen.getByTestId("feishu-step-4");
    expect(within(step4).getByText(tf("skillsCount", { done: 2, total: 25 }))).toBeInTheDocument();
    await user.click(within(step4).getByRole("button", { name: tf("skillsComplete") }));
    expect(feishu.installSkills).toHaveBeenCalledTimes(1);
  });

  it("还没拿到链接时不显示二维码", async () => {
    feishu.status.mockResolvedValue(status({ installed: true, configured: true, appId: "cli_a1", job: job({ kind: "login" }) }));
    render(<FeishuCliCard active />);
    const step3 = await screen.findByTestId("feishu-step-3");
    expect(within(step3).getByText(tf("preparing"))).toBeInTheDocument();
    expect(within(step3).queryByTestId("feishu-auth-qr")).not.toBeInTheDocument();
  });

  it("只有应用身份时引导登录，失败的任务显示原因", async () => {
    feishu.status.mockResolvedValue(status({
      installed: true,
      configured: true,
      appId: "cli_a1",
      identity: "bot",
      job: job({ kind: "login", stage: "error", error: "authorization denied" }),
    }));
    const user = userEvent.setup();
    render(<FeishuCliCard active />);
    const step3 = await screen.findByTestId("feishu-step-3");
    expect(within(step3).getByText(tf("botOnly"))).toBeInTheDocument();
    expect(within(step3).getByRole("alert")).toHaveTextContent("authorization denied");
    await user.click(within(step3).getByRole("button", { name: tf("login") }));
    expect(feishu.start).toHaveBeenCalledWith("login");
  });
});

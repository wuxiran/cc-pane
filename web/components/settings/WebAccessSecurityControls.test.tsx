import "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";

vi.mock("@/services/nativeDialog", () => ({ nativeConfirm: vi.fn(async () => true) }));
vi.mock("@/lib/feedback", () => ({ toastOk: vi.fn(), toastErr: vi.fn() }));
vi.mock("@/services/accessService", () => ({
  getTailscaleServeStatus: vi.fn(),
  startTailscaleServe: vi.fn(),
  stopTailscaleServe: vi.fn(),
  getOrchestratorRotationImpact: vi.fn(),
  rotateOrchestratorToken: vi.fn(async () => undefined),
}));

import * as accessService from "@/services/accessService";
import { nativeConfirm } from "@/services/nativeDialog";
import { toastErr } from "@/lib/feedback";
import TailscaleServeControls from "./TailscaleServeControls";
import OrchestratorTokenRotateRow from "./OrchestratorTokenRotateRow";

const tr = (key: string, options?: Record<string, unknown>) => String(i18n.t(`settings:${key}` as never, options as never));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TailscaleServeControls", () => {
  it("打开时只读状态，不执行 serve；点击才开启并显示地址", async () => {
    const user = userEvent.setup();
    vi.mocked(accessService.getTailscaleServeStatus).mockResolvedValue({ status: { active: false, url: null }, error: null });
    vi.mocked(accessService.startTailscaleServe).mockResolvedValue({
      status: { active: true, url: "https://my-pc.tail-1.ts.net/" },
      error: null,
    });
    render(<TailscaleServeControls onCopy={() => {}} />);
    await waitFor(() => expect(accessService.getTailscaleServeStatus).toHaveBeenCalledTimes(1));
    expect(accessService.startTailscaleServe).not.toHaveBeenCalled();
    expect(screen.getByTestId("tailscale-serve-state")).toHaveTextContent(tr("webAccessSection.tailscale.serve.off"));

    await user.click(screen.getByTestId("tailscale-serve-start"));
    await waitFor(() => expect(screen.getByTestId("tailscale-serve-state")).toHaveTextContent("https://my-pc.tail-1.ts.net/"));
    expect(screen.getByTestId("tailscale-serve-stop")).toBeInTheDocument();
  });

  it("需要管理员批准时给出审批链接", async () => {
    const user = userEvent.setup();
    vi.mocked(accessService.getTailscaleServeStatus).mockResolvedValue({ status: { active: false, url: null }, error: null });
    vi.mocked(accessService.startTailscaleServe).mockResolvedValue({
      status: null,
      error: { kind: "needsApproval", url: "https://login.tailscale.com/f/serve?node=abc" },
    });
    render(<TailscaleServeControls onCopy={() => {}} />);
    await user.click(await screen.findByTestId("tailscale-serve-start"));
    const message = tr("webAccessSection.tailscale.serve.errors.needsApproval", { url: "https://login.tailscale.com/f/serve?node=abc" });
    await waitFor(() => expect(screen.getByTestId("tailscale-serve-error")).toHaveTextContent(message));
    expect(toastErr).toHaveBeenCalledWith(message);
  });

  it("没装 tailscale / 没设密码给出明确说明", async () => {
    vi.mocked(accessService.getTailscaleServeStatus).mockResolvedValue({ status: null, error: { kind: "notInstalled" } });
    render(<TailscaleServeControls onCopy={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("tailscale-serve-error"))
      .toHaveTextContent(tr("webAccessSection.tailscale.serve.errors.notInstalled")));
  });
});

describe("OrchestratorTokenRotateRow", () => {
  it("确认框写明正在运行的会话数；取消则不更换", async () => {
    const user = userEvent.setup();
    vi.mocked(accessService.getOrchestratorRotationImpact).mockResolvedValue({ runningSessions: 4 });
    vi.mocked(nativeConfirm).mockResolvedValueOnce(false);
    render(<OrchestratorTokenRotateRow />);
    await user.click(screen.getByTestId("orchestrator-rotate-token"));
    expect(nativeConfirm).toHaveBeenCalledWith(tr("webAccessSection.orchestrator.rotate.confirm", { count: 4 }));
    expect(accessService.rotateOrchestratorToken).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("orchestrator-rotate-token"));
    await waitFor(() => expect(accessService.rotateOrchestratorToken).toHaveBeenCalledTimes(1));
  });
});

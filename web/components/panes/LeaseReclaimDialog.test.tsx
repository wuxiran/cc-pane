// 抢回写权限：确认对话框与只读横幅入口。
import "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reclaimSessionLease = vi.fn();
const toastOk = vi.fn();

vi.mock("@/hooks/leaseReclaim", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/leaseReclaim")>();
  return {
    ...actual,
    reclaimSessionLease: (...args: unknown[]) => reclaimSessionLease(...args),
  };
});

vi.mock("@/lib/feedback", () => ({
  toastOk: (...args: unknown[]) => toastOk(...args),
}));

import { useLeaseReclaimStore } from "@/hooks/leaseReclaim";
import LeaseReclaimDialog from "./LeaseReclaimDialog";
import LeaseReadOnlyBanner from "./LeaseReadOnlyBanner";

describe("LeaseReclaimDialog", () => {
  beforeEach(() => {
    reclaimSessionLease.mockReset();
    toastOk.mockReset();
    useLeaseReclaimStore.setState({ sessionId: null });
  });

  it("未请求时不显示", () => {
    render(<LeaseReclaimDialog />);
    expect(screen.queryByTestId("lease-reclaim-dialog")).not.toBeInTheDocument();
  });

  it("确认前说明另一个实例会变只读；成功后关闭并提示", async () => {
    reclaimSessionLease.mockResolvedValue("reclaimed");
    const user = userEvent.setup();
    useLeaseReclaimStore.setState({ sessionId: "s1" });
    render(<LeaseReclaimDialog />);

    expect(screen.getByText(/另一个实例中的同一终端会变为只读/)).toBeInTheDocument();
    await user.click(screen.getByTestId("lease-reclaim-confirm"));

    expect(reclaimSessionLease).toHaveBeenCalledWith("s1");
    await waitFor(() => expect(useLeaseReclaimStore.getState().sessionId).toBeNull());
    expect(toastOk).toHaveBeenCalledTimes(1);
  });

  it("失败时对话框保持打开并内联展示原因", async () => {
    reclaimSessionLease.mockResolvedValue("force-unsupported");
    const user = userEvent.setup();
    useLeaseReclaimStore.setState({ sessionId: "s1" });
    render(<LeaseReclaimDialog />);

    await user.click(screen.getByTestId("lease-reclaim-confirm"));

    expect(await screen.findByTestId("lease-reclaim-error")).toHaveTextContent(/不支持强制抢占/);
    expect(useLeaseReclaimStore.getState().sessionId).toBe("s1");
    expect(toastOk).not.toHaveBeenCalled();
  });

  it("取消只关闭，不执行抢回", async () => {
    const user = userEvent.setup();
    useLeaseReclaimStore.setState({ sessionId: "s1" });
    render(<LeaseReclaimDialog />);

    await user.click(screen.getByRole("button", { name: "取消" }));

    expect(reclaimSessionLease).not.toHaveBeenCalled();
    await waitFor(() => expect(useLeaseReclaimStore.getState().sessionId).toBeNull());
  });
});

describe("LeaseReadOnlyBanner", () => {
  beforeEach(() => {
    useLeaseReclaimStore.setState({ sessionId: null });
  });

  it("横幅按钮打开对应会话的抢回确认", async () => {
    const user = userEvent.setup();
    render(<LeaseReadOnlyBanner sessionId="s7" />);

    expect(screen.getByText(/只读：写权限由另一个 CC-Panes 实例持有/)).toBeInTheDocument();
    await user.click(screen.getByTestId("terminal-lease-reclaim-button"));

    expect(useLeaseReclaimStore.getState().sessionId).toBe("s7");
  });
});

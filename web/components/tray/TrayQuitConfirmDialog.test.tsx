// 托盘退出确认对话框：确认回调 Rust（confirm_tray_quit），取消只关窗不做事。
import "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TrayQuitConfirmDialog from "./TrayQuitConfirmDialog";
import { trayService } from "@/services/trayService";
import { useDialogStore } from "@/stores";

vi.mock("@/services/trayService", () => ({
  trayService: {
    confirmTrayQuit: vi.fn(async () => undefined),
  },
}));

describe("TrayQuitConfirmDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDialogStore.setState({ trayQuitConfirmOpen: true, trayQuitRunningCount: 3 });
  });

  it("打开时显示运行会话数", () => {
    render(<TrayQuitConfirmDialog />);

    expect(screen.getByText(/仍有 3 个会话正在运行/)).toBeInTheDocument();
  });

  it("确认后回调 Rust 退出并关闭对话框", async () => {
    const user = userEvent.setup();
    render(<TrayQuitConfirmDialog />);

    await user.click(screen.getByRole("button", { name: "退出" }));

    expect(trayService.confirmTrayQuit).toHaveBeenCalled();
    await waitFor(() =>
      expect(useDialogStore.getState().trayQuitConfirmOpen).toBe(false),
    );
  });

  it("取消只关闭对话框，不回调 Rust", async () => {
    const user = userEvent.setup();
    render(<TrayQuitConfirmDialog />);

    await user.click(screen.getByRole("button", { name: "取消" }));

    expect(trayService.confirmTrayQuit).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(useDialogStore.getState().trayQuitConfirmOpen).toBe(false),
    );
  });
});

// 托盘退出确认对话框：确认回调 Rust（confirm_tray_quit），取消只关窗不做事。
import "@/i18n";
import { render, waitFor } from "@testing-library/react";
import { ask } from "@tauri-apps/plugin-dialog";
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

  it("用系统对话框提示运行会话数", async () => {
    vi.mocked(ask).mockResolvedValueOnce(false);
    render(<TrayQuitConfirmDialog />);

    await waitFor(() =>
      expect(ask).toHaveBeenCalledWith(
        expect.stringMatching(/仍有 3 个会话正在运行/),
        expect.objectContaining({ okLabel: "退出" }),
      ),
    );
  });

  it("确认后回调 Rust 退出并关闭对话框", async () => {
    vi.mocked(ask).mockResolvedValueOnce(true);
    render(<TrayQuitConfirmDialog />);

    await waitFor(() => expect(trayService.confirmTrayQuit).toHaveBeenCalled());
    expect(useDialogStore.getState().trayQuitConfirmOpen).toBe(false);
  });

  it("取消只关闭对话框，不回调 Rust", async () => {
    vi.mocked(ask).mockResolvedValueOnce(false);
    render(<TrayQuitConfirmDialog />);

    await waitFor(() => expect(useDialogStore.getState().trayQuitConfirmOpen).toBe(false));
    expect(trayService.confirmTrayQuit).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import { invokeIfTauri } from "@/services/runtime";
import { trayService } from "./trayService";

vi.mock("@/services/runtime", () => ({
  invokeIfTauri: vi.fn(async () => undefined),
}));

describe("trayService", () => {
  it("confirmTrayQuit 映射到 confirm_tray_quit 命令", async () => {
    await trayService.confirmTrayQuit();

    expect(invokeIfTauri).toHaveBeenCalledWith("confirm_tray_quit");
  });
});

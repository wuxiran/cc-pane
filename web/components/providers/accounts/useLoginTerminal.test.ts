// 设置页开在独立的设置窗口时，登录终端交给主窗口开（两个窗口的 store 不相通）。
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/loginAccountService", () => ({
  loginAccountService: { getLoginCommand: vi.fn() },
}));
vi.mock("@/services/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/runtime")>()),
  isTauriRuntime: () => true,
}));
vi.mock("@/services/settingsWindowService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/settingsWindowService")>()),
  isSettingsWindow: () => true,
  sendActionToMainWindow: vi.fn(),
}));
vi.mock("@/components/home/installTerminal", () => ({ runCommandInNewTerminal: vi.fn() }));
vi.mock("@/components/home/agentCatalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/home/agentCatalog")>()),
  currentInstallPlatform: () => "macos",
}));
vi.mock("@/components/ui/toast", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));

const { loginAccountService } = await import("@/services/loginAccountService");
const { sendActionToMainWindow } = await import("@/services/settingsWindowService");
const { runCommandInNewTerminal } = await import("@/components/home/installTerminal");
const { useLoginTerminal } = await import("./useLoginTerminal");

describe("useLoginTerminal in the settings window", () => {
  beforeEach(() => {
    vi.mocked(sendActionToMainWindow).mockReset().mockResolvedValue(undefined);
    vi.mocked(loginAccountService.getLoginCommand).mockResolvedValue({
      cliTool: "claude",
      command: "/usr/local/bin/claude",
      args: ["auth", "login"],
      env: { CLAUDE_CONFIG_DIR: "/data/login-accounts/claude-1" },
      envRemove: ["ANTHROPIC_API_KEY"],
      interactive: false,
      executableFound: true,
    });
  });

  it("把带目录变量的登录命令发给主窗口执行，自己不开终端", async () => {
    const { result } = renderHook(() => useLoginTerminal());
    await expect(result.current("p-claude", "claude-1", "claude")).resolves.toBe("sent");

    expect(runCommandInNewTerminal).not.toHaveBeenCalled();
    expect(sendActionToMainWindow).toHaveBeenCalledTimes(1);
    const action = vi.mocked(sendActionToMainWindow).mock.calls[0][0];
    expect(action.type).toBe("runTerminalCommand");
    expect(action.type === "runTerminalCommand" && action.command).toContain(
      "CLAUDE_CONFIG_DIR='/data/login-accounts/claude-1'",
    );
  });

  it("主窗口收不到时退回复制命令", async () => {
    vi.mocked(sendActionToMainWindow).mockRejectedValue(new Error("no main window"));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    const { result } = renderHook(() => useLoginTerminal());
    await expect(result.current("p-claude", "claude-1", "claude")).resolves.toBe("copied");
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("CLAUDE_CONFIG_DIR="));
  });
});

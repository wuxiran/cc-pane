import { beforeEach, describe, expect, it, vi } from "vitest";
import * as sshMachineService from "@/services/sshMachineService";
import * as utils from "@/utils";
import { useEnvironmentStore } from "./useEnvironmentStore";

vi.mock("@/services/sshMachineService", () => ({
  discoverWslDistros: vi.fn(),
}));

vi.mock("@/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils")>();
  return {
    ...actual,
    detectAppPlatform: vi.fn(() => "unknown"),
  };
});

describe("useEnvironmentStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    useEnvironmentStore.setState({
      platform: "unknown",
      wsl: {
        status: "idle",
        available: false,
        distros: [],
        error: null,
        detectedAt: null,
      },
      _initialized: false,
    });
  });

  it("initializes WSL detection on Windows and caches the result", async () => {
    vi.mocked(utils.detectAppPlatform).mockReturnValue("windows");
    vi.mocked(sshMachineService.discoverWslDistros).mockResolvedValue([
      {
        name: "Ubuntu",
        state: "running",
        wslVersion: 2,
        isDefault: true,
        defaultUser: "dev",
        alreadyImported: false,
      },
    ]);

    await useEnvironmentStore.getState().init();

    const state = useEnvironmentStore.getState();
    expect(state.platform).toBe("windows");
    expect(state._initialized).toBe(true);
    expect(state.wsl.status).toBe("done");
    expect(state.wsl.available).toBe(true);
    expect(state.wsl.distros).toHaveLength(1);
    expect(state.wsl.detectedAt).toEqual(expect.any(Number));
  });

  it("marks WSL as unavailable without invoking detection on non-Windows platforms", async () => {
    vi.mocked(utils.detectAppPlatform).mockReturnValue("linux");

    await useEnvironmentStore.getState().init();

    const state = useEnvironmentStore.getState();
    expect(state.platform).toBe("linux");
    expect(state.wsl).toEqual({
      status: "done",
      available: false,
      distros: [],
      error: null,
      detectedAt: null,
    });
    expect(sshMachineService.discoverWslDistros).not.toHaveBeenCalled();
  });

  it("records refresh errors without throwing", async () => {
    vi.mocked(utils.detectAppPlatform).mockReturnValue("windows");
    vi.mocked(sshMachineService.discoverWslDistros).mockRejectedValue(
      new Error("wsl unavailable"),
    );

    await expect(useEnvironmentStore.getState().refreshWsl()).resolves.toBeUndefined();

    const state = useEnvironmentStore.getState();
    expect(state.wsl).toEqual({
      status: "error",
      available: false,
      distros: [],
      error: "wsl unavailable",
      detectedAt: null,
    });
    expect(console.warn).toHaveBeenCalled();
  });
});

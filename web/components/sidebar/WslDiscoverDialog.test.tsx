import "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useSshMachinesStore } from "@/stores";
import type { WslDistro } from "@/types";
import WslDiscoverDialog from "./WslDiscoverDialog";

vi.mock("@/components/ui/toast", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/services/sshMachineService", () => ({
  discoverWslDistros: vi.fn(async () => []),
}));

import { toast } from "@/components/ui/toast";
import { discoverWslDistros } from "@/services/sshMachineService";

const mockDiscover = vi.mocked(discoverWslDistros);

function createDistro(overrides: Partial<WslDistro> = {}): WslDistro {
  return {
    name: "Ubuntu",
    state: "running",
    wslVersion: 2,
    isDefault: false,
    defaultUser: "dev",
    alreadyImported: false,
    ...overrides,
  };
}

function renderDialog(open = true) {
  const onOpenChange = vi.fn();
  render(
    <TooltipProvider>
      <WslDiscoverDialog open={open} onOpenChange={onOpenChange} />
    </TooltipProvider>,
  );
  return { onOpenChange };
}

describe("WslDiscoverDialog", () => {
  let addMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    addMock = vi.fn(async () => ({}) as never);
    useSshMachinesStore.setState({ add: addMock as never, machines: [] });
    mockDiscover.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not discover when closed", () => {
    renderDialog(false);
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it("shows the loading state while discovering", async () => {
    let resolve: (v: WslDistro[]) => void = () => {};
    mockDiscover.mockReturnValue(new Promise<WslDistro[]>((r) => (resolve = r)));
    renderDialog();

    expect(
      await screen.findByText(/Scanning for WSL distributions|扫描/i),
    ).toBeVisible();

    resolve([]);
  });

  it("renders discovered distros and auto-selects importable ones", async () => {
    mockDiscover.mockResolvedValue([
      createDistro({ name: "Ubuntu", state: "running" }),
      createDistro({ name: "Debian", state: "stopped" }),
    ]);
    renderDialog();

    expect(await screen.findByText("Ubuntu")).toBeVisible();
    expect(screen.getByText("Debian")).toBeVisible();

    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(checkboxes.every((c) => c.checked)).toBe(true);
    // import button reflects the selectable count
    expect(
      screen.getByRole("button", { name: /Import \(2\)|导入 \(2\)/i }),
    ).toBeEnabled();
  });

  it("does not auto-select installing distros", async () => {
    mockDiscover.mockResolvedValue([
      createDistro({ name: "Installing", state: "installing" }),
    ]);
    renderDialog();

    await screen.findByText("Installing");
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(
      screen.getByRole("button", { name: /Import \(0\)|导入 \(0\)/i }),
    ).toBeDisabled();
  });

  it("disables checkbox and does not select already imported distros", async () => {
    mockDiscover.mockResolvedValue([
      createDistro({ name: "Imported", alreadyImported: true }),
    ]);
    renderDialog();

    await screen.findByText("Imported");
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox).toBeDisabled();
    expect(checkbox.checked).toBe(false);
  });

  it("shows the empty state when no distros are found", async () => {
    mockDiscover.mockResolvedValue([]);
    renderDialog();

    expect(
      await screen.findByText(/No WSL distributions found|未找到/i),
    ).toBeVisible();
  });

  it("shows an error message when discovery fails", async () => {
    mockDiscover.mockRejectedValue(new Error("wsl.exe not found"));
    renderDialog();

    expect(await screen.findByText("wsl.exe not found")).toBeVisible();
  });

  it("toggles selection when clicking a checkbox", async () => {
    const user = userEvent.setup();
    mockDiscover.mockResolvedValue([createDistro({ name: "Ubuntu" })]);
    renderDialog();

    await screen.findByText("Ubuntu");
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    await user.click(checkbox);
    expect(checkbox.checked).toBe(false);
    expect(
      screen.getByRole("button", { name: /Import \(0\)|导入 \(0\)/i }),
    ).toBeDisabled();
  });

  it("imports selected distros and closes on success", async () => {
    const user = userEvent.setup();
    mockDiscover.mockResolvedValue([
      createDistro({ name: "Ubuntu", defaultUser: "dev" }),
    ]);
    const { onOpenChange } = renderDialog();

    await screen.findByText("Ubuntu");
    await user.click(
      screen.getByRole("button", { name: /Import \(1\)|导入 \(1\)/i }),
    );

    await waitFor(() => expect(addMock).toHaveBeenCalledTimes(1));
    const arg = addMock.mock.calls[0][0];
    expect(arg.machine).toMatchObject({
      name: "WSL: Ubuntu",
      host: "localhost",
      port: 22,
      user: "dev",
      authMethod: "password",
      tags: ["wsl"],
    });
    expect(toast.success).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("reports per-distro failures but still closes", async () => {
    const user = userEvent.setup();
    addMock.mockRejectedValueOnce(new Error("keychain locked"));
    mockDiscover.mockResolvedValue([createDistro({ name: "Ubuntu" })]);
    const { onOpenChange } = renderDialog();

    await screen.findByText("Ubuntu");
    await user.click(
      screen.getByRole("button", { name: /Import \(1\)|导入 \(1\)/i }),
    );

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    // no success toast because successCount stays 0
    expect(toast.success).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes without importing when cancel is clicked", async () => {
    const user = userEvent.setup();
    mockDiscover.mockResolvedValue([createDistro({ name: "Ubuntu" })]);
    const { onOpenChange } = renderDialog();

    await screen.findByText("Ubuntu");
    await user.click(screen.getByRole("button", { name: /Cancel|取消/i }));

    expect(addMock).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

import "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSshMachinesStore, useWorkspacesStore } from "@/stores";
import type { SshMachine } from "@/types";
import AddSshProjectDialog from "./AddSshProjectDialog";

vi.mock("@/components/ui/toast", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { toast } from "@/components/ui/toast";

function createMachine(overrides: Partial<SshMachine> = {}): SshMachine {
  return {
    id: "m-1",
    name: "devbox",
    host: "devbox.local",
    port: 2222,
    user: "dev",
    authMethod: "key",
    identityFile: "~/.ssh/id_devbox",
    tags: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function inputByLabel(keyword: RegExp): HTMLInputElement {
  const labels = Array.from(document.querySelectorAll("label"));
  const labelEl = labels.find((l) => keyword.test(l.textContent || ""));
  const field = labelEl?.closest("div");
  const input = field?.querySelector("input");
  if (!input) throw new Error(`no input for label ${keyword}`);
  return input as HTMLInputElement;
}

function renderDialog(open = true, workspaceName = "ws-alpha") {
  const onOpenChange = vi.fn();
  render(
    <AddSshProjectDialog
      open={open}
      onOpenChange={onOpenChange}
      workspaceName={workspaceName}
    />,
  );
  return { onOpenChange };
}

describe("AddSshProjectDialog", () => {
  let addSshProjectMock: ReturnType<typeof vi.fn>;
  let loadMock: ReturnType<typeof vi.fn>;
  let addMachineMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    addSshProjectMock = vi.fn(async () => ({}) as never);
    loadMock = vi.fn(async () => undefined);
    addMachineMock = vi.fn(async (req) => req.machine);
    useWorkspacesStore.setState({ addSshProject: addSshProjectMock as never });
    useSshMachinesStore.setState({
      machines: [],
      load: loadMock as never,
      add: addMachineMock as never,
    });
  });

  it("loads machines when opened", () => {
    renderDialog(true);
    expect(loadMock).toHaveBeenCalled();
  });

  it("rejects submit when host is empty", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog(true);

    await user.type(inputByLabel(/远程路径|Remote Path/), "/home/dev/repo");
    await user.click(screen.getByRole("button", { name: /Confirm|确定/i }));

    expect(toast.error).toHaveBeenCalled();
    expect(addSshProjectMock).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("rejects submit when remote path is empty", async () => {
    const user = userEvent.setup();
    renderDialog(true);

    await user.type(inputByLabel(/主机|Host/), "example.com");
    await user.click(screen.getByRole("button", { name: /Confirm|确定/i }));

    expect(toast.error).toHaveBeenCalled();
    expect(addSshProjectMock).not.toHaveBeenCalled();
  });

  it("rejects a non-absolute remote path", async () => {
    const user = userEvent.setup();
    renderDialog(true);

    await user.type(inputByLabel(/主机|Host/), "example.com");
    await user.type(inputByLabel(/远程路径|Remote Path/), "relative/path");
    await user.click(screen.getByRole("button", { name: /Confirm|确定/i }));

    expect(toast.error).toHaveBeenCalled();
    expect(addSshProjectMock).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range port", async () => {
    const user = userEvent.setup();
    renderDialog(true);

    await user.type(inputByLabel(/主机|Host/), "example.com");
    await user.type(inputByLabel(/远程路径|Remote Path/), "/home/dev/repo");
    const portInput = inputByLabel(/端口|Port/);
    await user.clear(portInput);
    await user.type(portInput, "0");
    await user.click(screen.getByRole("button", { name: /Confirm|确定/i }));

    expect(toast.error).toHaveBeenCalled();
    expect(addSshProjectMock).not.toHaveBeenCalled();
  });

  it("submits a manually entered ssh project and syncs a machine", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog(true);

    await user.type(inputByLabel(/主机|Host/), "example.com");
    await user.type(inputByLabel(/远程路径|Remote Path/), "/home/dev/repo");
    await user.type(inputByLabel(/用户|User/), "dev");
    await user.click(screen.getByRole("button", { name: /Confirm|确定/i }));

    await waitFor(() => expect(addSshProjectMock).toHaveBeenCalledTimes(1));
    const [wsName, sshInfo] = addSshProjectMock.mock.calls[0];
    expect(wsName).toBe("ws-alpha");
    expect(sshInfo).toMatchObject({
      host: "example.com",
      port: 22,
      user: "dev",
      remotePath: "/home/dev/repo",
    });
    // manual entry with no identity file syncs a machine with agent auth
    expect(addMachineMock).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not sync an already known machine", async () => {
    const user = userEvent.setup();
    const existing = createMachine({ host: "example.com", port: 22, user: "dev" });
    const findByConnection = vi.fn(() => existing);
    useSshMachinesStore.setState({
      machines: [],
      load: loadMock as never,
      add: addMachineMock as never,
      findByConnection: findByConnection as never,
    });
    renderDialog(true);

    await user.type(inputByLabel(/主机|Host/), "example.com");
    await user.type(inputByLabel(/远程路径|Remote Path/), "/home/dev/repo");
    await user.type(inputByLabel(/用户|User/), "dev");
    await user.click(screen.getByRole("button", { name: /Confirm|确定/i }));

    await waitFor(() => expect(addSshProjectMock).toHaveBeenCalled());
    expect(findByConnection).toHaveBeenCalledWith("example.com", 22, "dev");
    // existing machine found -> no new machine added
    expect(addMachineMock).not.toHaveBeenCalled();
    const sshInfo = addSshProjectMock.mock.calls[0][1];
    expect(sshInfo.machineId).toBe("m-1");
  });

  it("renders a machine selector and fills fields when a machine is chosen", async () => {
    const user = userEvent.setup();
    const machine = createMachine();
    useSshMachinesStore.setState({
      machines: [machine],
      load: loadMock as never,
      add: addMachineMock as never,
    });
    renderDialog(true);

    const select = await screen.findByRole("combobox");
    await user.selectOptions(select, "m-1");

    // host/port/user autofilled and disabled
    const hostInput = inputByLabel(/主机|Host/);
    expect(hostInput.value).toBe("devbox.local");
    expect(hostInput).toBeDisabled();
    expect(inputByLabel(/端口|Port/).value).toBe("2222");
    expect(inputByLabel(/用户|User/).value).toBe("dev");
  });

  it("submits with the selected machine's id and connection", async () => {
    const user = userEvent.setup();
    const machine = createMachine();
    useSshMachinesStore.setState({
      machines: [machine],
      load: loadMock as never,
      add: addMachineMock as never,
    });
    const { onOpenChange } = renderDialog(true);

    const select = await screen.findByRole("combobox");
    await user.selectOptions(select, "m-1");
    await user.type(inputByLabel(/远程路径|Remote Path/), "/srv/app");
    await user.click(screen.getByRole("button", { name: /Confirm|确定/i }));

    await waitFor(() => expect(addSshProjectMock).toHaveBeenCalledTimes(1));
    const sshInfo = addSshProjectMock.mock.calls[0][1];
    expect(sshInfo).toMatchObject({
      host: "devbox.local",
      port: 2222,
      user: "dev",
      remotePath: "/srv/app",
      machineId: "m-1",
      authMethod: "key",
    });
    // selecting an existing machine does not create a new one
    expect(addMachineMock).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows an error toast when adding the project fails", async () => {
    const user = userEvent.setup();
    addSshProjectMock.mockRejectedValueOnce(new Error("workspace missing"));
    const { onOpenChange } = renderDialog(true);

    await user.type(inputByLabel(/主机|Host/), "example.com");
    await user.type(inputByLabel(/远程路径|Remote Path/), "/home/dev/repo");
    await user.click(screen.getByRole("button", { name: /Confirm|确定/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("closes without submitting when cancel is clicked", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog(true);

    await user.click(screen.getByRole("button", { name: /Cancel|取消/i }));

    expect(addSshProjectMock).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

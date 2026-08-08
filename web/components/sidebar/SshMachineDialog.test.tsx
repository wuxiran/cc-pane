import i18n from "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useSshMachinesStore } from "@/stores";
import type { SshMachine } from "@/types";
import SshMachineDialog from "./SshMachineDialog";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/services/sshMachineService", () => ({
  checkSshConnectivity: vi.fn(async () => ({
    reachable: true,
    message: "Connected in 12ms",
    latencyMs: 12,
  })),
}));

import { toast } from "sonner";
import { checkSshConnectivity } from "@/services/sshMachineService";

const mockCheck = vi.mocked(checkSshConnectivity);

function createMachine(overrides: Partial<SshMachine> = {}): SshMachine {
  return {
    id: "m-1",
    name: "My Server",
    host: "192.168.1.100",
    port: 22,
    user: "dev",
    authMethod: "key",
    identityFile: "~/.ssh/id_rsa",
    description: "prod box",
    defaultPath: "~/projects",
    tags: ["production", "web"],
    hasStoredPassword: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function renderDialog(machine: SshMachine | null = null, open = true) {
  const onOpenChange = vi.fn();
  render(
    <TooltipProvider>
      <SshMachineDialog
        open={open}
        onOpenChange={onOpenChange}
        machine={machine}
      />
    </TooltipProvider>,
  );
  return { onOpenChange };
}

/** Grab an <input> by the (bilingual) label text of its wrapping field block. */
function inputByLabel(keyword: RegExp): HTMLInputElement {
  const labels = Array.from(document.querySelectorAll("label"));
  const labelEl = labels.find((l) => keyword.test(l.textContent || ""));
  const field = labelEl?.closest("div");
  const input = field?.querySelector("input, textarea");
  if (!input) throw new Error(`no input for label ${keyword}`);
  return input as HTMLInputElement;
}

describe("SshMachineDialog", () => {
  let addMock: ReturnType<typeof vi.fn>;
  let updateMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage("zh-CN");
    addMock = vi.fn(async () => ({}) as never);
    updateMock = vi.fn(async () => ({}) as never);
    useSshMachinesStore.setState({
      add: addMock as never,
      update: updateMock as never,
    });
    mockCheck.mockResolvedValue({
      reachable: true,
      message: "Connected in 12ms",
      latencyMs: 12,
    });
  });

  it("renders the add title when no machine is provided", () => {
    renderDialog(null);
    expect(
      screen.getByRole("heading", { name: /Add SSH Machine|添加/i }),
    ).toBeVisible();
    // Quick connect only appears in add mode
    expect(screen.getByPlaceholderText("user@host:port")).toBeInTheDocument();
  });

  it("prefills fields and shows edit title when editing", () => {
    renderDialog(createMachine());
    expect(
      screen.getByRole("heading", { name: /Edit SSH Machine|编辑/i }),
    ).toBeVisible();
    expect(screen.getByDisplayValue("My Server")).toBeInTheDocument();
    expect(screen.getByDisplayValue("192.168.1.100")).toBeInTheDocument();
    expect(screen.getByDisplayValue("dev")).toBeInTheDocument();
    expect(screen.getByDisplayValue("production, web")).toBeInTheDocument();
    // no quick connect in edit mode
    expect(
      screen.queryByPlaceholderText("user@host:port"),
    ).not.toBeInTheDocument();
  });

  it("switches default-path and connection-test labels with the app language", async () => {
    renderDialog(createMachine());

    expect(inputByLabel(/^默认路径$/)).toHaveValue("~/projects");
    expect(screen.getByPlaceholderText("~/projects（默认：~）")).toBeVisible();
    expect(screen.getByRole("button", { name: "测试" })).toBeVisible();

    await act(async () => {
      await i18n.changeLanguage("en");
    });
    expect(inputByLabel(/^Default Path$/)).toHaveValue("~/projects");
    expect(screen.getByPlaceholderText("~/projects (default: ~)")).toBeVisible();
    expect(screen.getByRole("button", { name: "Test" })).toBeVisible();
  });

  it("rejects submit when the name is empty", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog(null);

    await user.click(screen.getByRole("button", { name: /Confirm|确定/i }));

    expect(toast.error).toHaveBeenCalled();
    expect(addMock).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("rejects submit when the host is empty", async () => {
    const user = userEvent.setup();
    renderDialog(null);

    await user.type(inputByLabel(/Name|名称/), "New Box");
    await user.click(screen.getByRole("button", { name: /Confirm|确定/i }));

    expect(toast.error).toHaveBeenCalled();
    expect(addMock).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range port", async () => {
    const user = userEvent.setup();
    renderDialog(null);

    await user.type(inputByLabel(/Name|名称/), "New Box");
    await user.type(inputByLabel(/Host|主机/), "example.com");
    const portInput = inputByLabel(/Port|端口/);
    await user.clear(portInput);
    await user.type(portInput, "70000");
    await user.click(screen.getByRole("button", { name: /Confirm|确定/i }));

    expect(toast.error).toHaveBeenCalled();
    expect(addMock).not.toHaveBeenCalled();
  });

  it("adds a machine with the entered values", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog(null);

    await user.type(inputByLabel(/Name|名称/), "New Box");
    await user.type(inputByLabel(/Host|主机/), "example.com");
    await user.type(inputByLabel(/Tags|标签/), "a, b");
    await user.click(screen.getByRole("button", { name: /Confirm|确定/i }));

    await waitFor(() => expect(addMock).toHaveBeenCalledTimes(1));
    const req = addMock.mock.calls[0][0];
    expect(req.machine).toMatchObject({
      name: "New Box",
      host: "example.com",
      port: 22,
      authMethod: "key",
      tags: ["a", "b"],
    });
    expect(toast.success).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("parses quick connect input into fields on blur", async () => {
    renderDialog(null);
    const quick = screen.getByPlaceholderText("user@host:port");
    fireEvent.blur(quick, { target: { value: "root@10.0.0.5:2222" } });

    // both host and name inputs get the parsed host value
    expect(screen.getAllByDisplayValue("10.0.0.5").length).toBeGreaterThanOrEqual(
      2,
    );
    expect(screen.getByDisplayValue("root")).toBeInTheDocument();
    expect(screen.getByDisplayValue("2222")).toBeInTheDocument();
  });

  it("shows the password section only for password auth", async () => {
    const user = userEvent.setup();
    renderDialog(null);

    expect(
      screen.queryByText(/Password Storage|密码存储/i),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Password$|^密码$/ }));
    expect(await screen.findByText(/Password Storage|密码存储/i)).toBeVisible();
  });

  it("requires a password before remembering it on add", async () => {
    const user = userEvent.setup();
    renderDialog(null);

    await user.type(inputByLabel(/Name|名称/), "New Box");
    await user.type(inputByLabel(/Host|主机/), "example.com");
    await user.click(screen.getByRole("button", { name: /^Password$|^密码$/ }));
    // enable remember without typing a password
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: /Confirm|确定/i }));

    expect(toast.error).toHaveBeenCalled();
    expect(addMock).not.toHaveBeenCalled();
  });

  it("updates an existing machine and closes", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog(createMachine());

    const nameInput = screen.getByDisplayValue("My Server");
    await user.clear(nameInput);
    await user.type(nameInput, "Renamed Box");
    await user.click(screen.getByRole("button", { name: /Confirm|确定/i }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    expect(updateMock.mock.calls[0][0].machine).toMatchObject({
      id: "m-1",
      name: "Renamed Box",
    });
    expect(addMock).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows an error toast when saving fails", async () => {
    const user = userEvent.setup();
    addMock.mockRejectedValueOnce(new Error("db locked"));
    const { onOpenChange } = renderDialog(null);

    await user.type(inputByLabel(/Name|名称/), "New Box");
    await user.type(inputByLabel(/Host|主机/), "example.com");
    await user.click(screen.getByRole("button", { name: /Confirm|确定/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    // dialog stays open on failure
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("tests connectivity for a saved unchanged machine", async () => {
    const user = userEvent.setup();
    renderDialog(createMachine());

    await user.click(screen.getByRole("button", { name: /Test|测试/i }));

    await waitFor(() => expect(mockCheck).toHaveBeenCalledWith("m-1"));
    expect(toast.success).toHaveBeenCalledWith("连接成功，用时 12 毫秒");
  });

  it("localizes the reachable host prompt when a password is still required", async () => {
    const user = userEvent.setup();
    mockCheck.mockResolvedValueOnce({
      reachable: true,
      message: "SSH host reachable; enter a password to validate authentication",
      latencyMs: 12,
    });
    renderDialog(createMachine({ authMethod: "password" }));

    await user.click(screen.getByRole("button", { name: "测试" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(
      "SSH 主机可访问；请输入密码以验证身份",
    ));
  });

  it("disables the test button while the form is dirty", async () => {
    const user = userEvent.setup();
    renderDialog(createMachine());

    const nameInput = screen.getByDisplayValue("My Server");
    await user.type(nameInput, "X");

    expect(screen.getByRole("button", { name: /Test|测试/i })).toBeDisabled();
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("closes without saving when cancel is clicked", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog(null);

    await user.click(screen.getByRole("button", { name: /Cancel|取消/i }));

    expect(addMock).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

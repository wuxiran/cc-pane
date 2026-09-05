import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ImportRequest } from "@/services/importService";
import { useProvidersStore } from "@/stores/useProvidersStore";
import { useSharedMcpStore } from "@/stores";
import ImportConfirmDialog from "./ImportConfirmDialog";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const mocks = vi.hoisted(() => ({
  executeImport: vi.fn(),
  takePendingImport: vi.fn(),
  importCb: { current: null as ((r: ImportRequest) => void) | null },
  importErrCb: { current: null as ((m: string) => void) | null },
}));

vi.mock("@/services/importService", () => ({
  importService: {
    onImport: (cb: (r: ImportRequest) => void) => {
      mocks.importCb.current = cb;
      return Promise.resolve(() => {});
    },
    onImportError: (cb: (m: string) => void) => {
      mocks.importErrCb.current = cb;
      return Promise.resolve(() => {});
    },
    takePendingImport: () => mocks.takePendingImport(),
    executeImport: (req: ImportRequest) => mocks.executeImport(req),
  },
}));

const { toast } = await import("sonner");

const providerReq: ImportRequest = {
  resource: "provider",
  name: "my-provider",
  app: "claude",
  endpoints: ["https://api.example.com"],
  apiKey: "sk-ant-api-key-xyz",
};

const mcpReq: ImportRequest = {
  resource: "mcp",
  name: "fs-server",
  config: { command: "npx" },
};

const tKey = (k: string) => String(i18n.t(`dialogs:${k}` as never));

async function emitImport(req: ImportRequest) {
  render(<ImportConfirmDialog />);
  await waitFor(() => expect(mocks.importCb.current).not.toBeNull());
  act(() => mocks.importCb.current?.(req));
  await screen.findByRole("dialog");
}

describe("ImportConfirmDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.importCb.current = null;
    mocks.importErrCb.current = null;
    mocks.takePendingImport.mockResolvedValue(null);
    mocks.executeImport.mockResolvedValue("imported ok");
    useProvidersStore.setState({ loadProviders: vi.fn().mockResolvedValue(undefined) } as never);
    useSharedMcpStore.setState({ fetchConfig: vi.fn().mockResolvedValue(undefined) } as never);
  });

  it("shows provider details in a labelled dialog when an import event arrives", async () => {
    await emitImport(providerReq);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(tKey("importDialog.titleProvider"));
    expect(dialog).toHaveTextContent(tKey("importDialog.sourceHint"));
    expect(screen.getByText("my-provider")).toBeInTheDocument();
    // API Key 打码展示
    expect(screen.getByText("sk-ant***xyz")).toBeInTheDocument();
    // 信任提示作为 dialog description
    expect(dialog).toHaveTextContent(tKey("importDialog.trustHint"));
  });

  it("shows mcp details for mcp imports", async () => {
    await emitImport(mcpReq);
    expect(screen.getByRole("dialog")).toHaveTextContent(tKey("importDialog.titleMcp"));
    expect(screen.getByText("fs-server")).toBeInTheDocument();
  });

  it("gives the close button an accessible name and closes on click", async () => {
    const user = userEvent.setup();
    await emitImport(providerReq);
    await user.click(screen.getByRole("button", { name: i18n.t("common:close") }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("closes on Escape without executing the import", async () => {
    const user = userEvent.setup();
    await emitImport(providerReq);
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(mocks.executeImport).not.toHaveBeenCalled();
  });

  it("executes the import on confirm, refreshes providers and closes", async () => {
    const user = userEvent.setup();
    const loadProviders = vi.fn().mockResolvedValue(undefined);
    useProvidersStore.setState({ loadProviders } as never);
    await emitImport(providerReq);

    await user.click(screen.getByRole("button", { name: tKey("importDialog.confirmImport") }));
    await waitFor(() => {
      expect(mocks.executeImport).toHaveBeenCalledWith(providerReq);
    });
    expect(toast.success).toHaveBeenCalledWith("imported ok", expect.objectContaining({ duration: expect.any(Number) }));
    await waitFor(() => {
      expect(loadProviders).toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("surfaces parse failures as error toasts", async () => {
    render(<ImportConfirmDialog />);
    await waitFor(() => expect(mocks.importErrCb.current).not.toBeNull());
    act(() => mocks.importErrCb.current?.("bad link"));
    expect(toast.error).toHaveBeenCalledWith(
      String(i18n.t("dialogs:importLinkParseFailed", { error: "bad link" })),
      expect.objectContaining({ duration: expect.any(Number) }),
    );
  });

  it("picks up a pending cold-start import on mount", async () => {
    mocks.takePendingImport.mockResolvedValue(providerReq);
    render(<ImportConfirmDialog />);
    expect(await screen.findByRole("dialog")).toHaveTextContent(tKey("importDialog.titleProvider"));
  });

  it("keeps the dialog open while the import is busy", async () => {
    const user = userEvent.setup();
    mocks.executeImport.mockReturnValue(new Promise(() => {}));
    await emitImport(providerReq);

    await user.click(screen.getByRole("button", { name: tKey("importDialog.confirmImport") }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: i18n.t("common:cancel") })).toBeDisabled();
    });
    // busy 中 Esc 不关闭
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

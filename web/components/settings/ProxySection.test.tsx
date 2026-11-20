import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "@/components/ui/toast";
import { settingsService } from "@/services";
import type { ProxySettings } from "@/types";
import ProxySection from "./ProxySection";

vi.mock("@/services/settingsService", () => ({
  settingsService: {
    testProxy: vi.fn(),
  },
}));

vi.mock("@/components/ui/toast", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

function createValue(overrides: Partial<ProxySettings> = {}): ProxySettings {
  return {
    enabled: true,
    proxyType: "http",
    host: "127.0.0.1",
    port: 7890,
    username: null,
    password: null,
    noProxy: null,
    ...overrides,
  };
}

describe("ProxySection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hides proxy detail fields when disabled", () => {
    render(<ProxySection value={createValue({ enabled: false })} onChange={vi.fn()} />);

    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("emits enabled=true when the switch is checked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ProxySection value={createValue({ enabled: false })} onChange={onChange} />);

    await user.click(screen.getByRole("checkbox"));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });

  it("shows a SOCKS5 warning only for the socks5 proxy type", () => {
    const { rerender } = render(<ProxySection value={createValue()} onChange={vi.fn()} />);
    expect(document.body.textContent).not.toContain("⚠");

    rerender(<ProxySection value={createValue({ proxyType: "socks5" })} onChange={vi.fn()} />);
    expect(document.body.textContent).toContain("⚠");
  });

  it("emits host and numeric port updates", () => {
    const onChange = vi.fn();
    render(<ProxySection value={createValue()} onChange={onChange} />);

    fireEvent.change(screen.getByDisplayValue("127.0.0.1"), { target: { value: "10.0.0.1" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ host: "10.0.0.1" }));

    fireEvent.change(screen.getByDisplayValue("7890"), { target: { value: "8080" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ port: 8080 }));
  });

  it("normalizes cleared username/password/noProxy to null", () => {
    const onChange = vi.fn();
    render(
      <ProxySection
        value={createValue({ username: "user", password: "pass", noProxy: "localhost" })}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByDisplayValue("user"), { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ username: null }));

    fireEvent.change(screen.getByDisplayValue("pass"), { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ password: null }));

    fireEvent.change(screen.getByDisplayValue("localhost"), { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ noProxy: null }));
  });

  it("shows a success toast when the proxy test passes", async () => {
    const user = userEvent.setup();
    vi.mocked(settingsService.testProxy).mockResolvedValue(undefined as never);
    render(<ProxySection value={createValue()} onChange={vi.fn()} />);

    await user.click(screen.getByRole("button"));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("shows an error toast when the proxy test fails", async () => {
    const user = userEvent.setup();
    vi.mocked(settingsService.testProxy).mockRejectedValue(new Error("connect refused"));
    render(<ProxySection value={createValue()} onChange={vi.fn()} />);

    await user.click(screen.getByRole("button"));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });
});

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import PermissionPolicyDropdown from "./PermissionPolicyDropdown";
import { AUTO_APPROVE_ALL, presetKinds } from "./permissionPolicy";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, options?: { count?: number }) => (options?.count !== undefined ? `${key}:${options.count}` : key) }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

async function open(kinds: string[], onChange = vi.fn()) {
  const user = userEvent.setup();
  render(<PermissionPolicyDropdown kinds={kinds} onChange={onChange} />);
  await user.click(screen.getByRole("button", { name: "agentChatPermTitle" }));
  return { user, onChange };
}

describe("PermissionPolicyDropdown", () => {
  it("names the current preset on the trigger", () => {
    const { rerender } = render(<PermissionPolicyDropdown kinds={[]} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "agentChatPermTitle" })).toHaveTextContent("agentChatPermAsk");
    rerender(<PermissionPolicyDropdown kinds={presetKinds("assist")} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "agentChatPermTitle" })).toHaveTextContent("agentChatPermAssist");
    rerender(<PermissionPolicyDropdown kinds={[AUTO_APPROVE_ALL]} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "agentChatPermTitle" })).toHaveTextContent("agentChatPermFullShort");
    rerender(<PermissionPolicyDropdown kinds={["read", "search"]} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "agentChatPermTitle" })).toHaveTextContent("agentChatPermCustomCount:1");
  });

  it("offers three presets and marks the current one", async () => {
    await open([]);
    expect(screen.getByTestId("permission-preset-ask")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("permission-preset-assist")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("permission-preset-full")).toHaveAttribute("aria-checked", "false");
  });

  it("applies the lower presets immediately", async () => {
    const { user, onChange } = await open([]);
    await user.click(screen.getByTestId("permission-preset-assist"));
    expect(onChange).toHaveBeenCalledWith(presetKinds("assist"));
    expect(screen.queryByTestId("permission-full-confirm")).not.toBeInTheDocument();
  });

  it("asks for confirmation before turning on full access", async () => {
    const { user, onChange } = await open([]);
    await user.click(screen.getByTestId("permission-preset-full"));
    expect(onChange).not.toHaveBeenCalled();
    const dialog = await screen.findByTestId("permission-full-confirm");
    expect(within(dialog).getByText("agentChatPermFullFiles")).toBeInTheDocument();
    expect(within(dialog).getByText("agentChatPermFullCommands")).toBeInTheDocument();
    expect(within(dialog).getByText("agentChatPermFullNetwork")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "confirm" }));
    expect(onChange).toHaveBeenCalledWith([AUTO_APPROVE_ALL]);
  });

  it("leaves the policy unchanged when the confirmation is cancelled", async () => {
    const { user, onChange } = await open(presetKinds("assist"));
    await user.click(screen.getByTestId("permission-preset-full"));
    const dialog = await screen.findByTestId("permission-full-confirm");
    await user.click(within(dialog).getByRole("button", { name: "cancel" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does nothing when the current preset is picked again", async () => {
    const { user, onChange } = await open([AUTO_APPROVE_ALL]);
    await user.click(screen.getByTestId("permission-preset-full"));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId("permission-full-confirm")).not.toBeInTheDocument();
  });
});

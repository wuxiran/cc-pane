import "@/i18n";
import { fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import MachineItem from "./SshMachineItem";
import type { SshMachine } from "@/types";

function makeMachine(overrides: Partial<SshMachine> = {}): SshMachine {
  return {
    id: "m-1",
    name: "devbox",
    host: "devbox.local",
    port: 22,
    user: "dev",
    authMethod: "key",
    tags: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function renderItem(overrides: Record<string, unknown> = {}) {
  const props = {
    machine: makeMachine(),
    connectivity: null,
    favorite: false,
    selected: false,
    onSelect: vi.fn(),
    onConnect: vi.fn(),
    onOpenFiles: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onCopy: vi.fn(),
    onCheckConnectivity: vi.fn(),
    onToggleFavorite: vi.fn(),
    ...overrides,
  };
  const { container } = render(
    <TooltipProvider>
      <MachineItem {...props} />
    </TooltipProvider>,
  );
  return { ...props, container };
}

/** 机器行是唯一显式声明 role="button" 的元素（操作按钮均为原生 button） */
function rowElement(container: HTMLElement): HTMLElement {
  return container.querySelector('[role="button"]') as HTMLElement;
}

describe("SshMachineItem keyboard accessibility", () => {
  it("机器行可 Tab 聚焦并带 focus-visible 焦点环", async () => {
    const user = userEvent.setup();
    const { container } = renderItem();

    const row = rowElement(container);
    expect(row).not.toBeNull();
    expect(row).toHaveAttribute("tabindex", "0");
    expect(row.className).toContain("focus-visible:outline-none");
    expect(row.className).toContain("focus-visible:ring-2");
    expect(row.className).toContain("focus-visible:ring-[var(--app-accent)]");

    await user.tab();
    expect(row).toHaveFocus();
  });

  it("Enter/Space 触发选中，双击连接行为不变", async () => {
    const user = userEvent.setup();
    const props = renderItem();
    const row = rowElement(props.container);

    row.focus();
    fireEvent.keyDown(row, { key: "Enter" });
    expect(props.onSelect).toHaveBeenCalledTimes(1);
    expect(props.onSelect).toHaveBeenCalledWith(props.machine);

    fireEvent.keyDown(row, { key: " " });
    expect(props.onSelect).toHaveBeenCalledTimes(2);
    expect(props.onConnect).not.toHaveBeenCalled();

    await user.dblClick(row);
    expect(props.onConnect).toHaveBeenCalledWith(props.machine);
  });
});
